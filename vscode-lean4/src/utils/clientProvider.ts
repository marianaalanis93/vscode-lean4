import { Disposable, OutputChannel, workspace, TextDocument, commands, window, EventEmitter, Uri, languages, TextEditor } from 'vscode';
import { LocalStorageService} from './localStorage'
import { LeanInstaller, LeanVersion } from './leanInstaller'
import { LeanpkgService } from './leanpkg';
import { LeanClient } from '../leanclient'
import { LeanFileProgressProcessingInfo, RpcConnectParams, RpcKeepAliveParams } from '@lean4/infoview-api';
import * as path from 'path';
import { findLeanPackageRoot } from './projectInfo';

// This class ensures we have one LeanClient per workspace folder.
export class LeanClientProvider implements Disposable {
    private subscriptions: Disposable[] = [];
    private localStorage: LocalStorageService;
    private outputChannel: OutputChannel;
    private installer : LeanInstaller;
    private pkgService : LeanpkgService;
    private versions: Map<string, LeanVersion> = new Map();
    private clients: Map<string, LeanClient> = new Map();
    private pending: Map<string, boolean> = new Map();
    private testing: Map<string, boolean> = new Map();
    private activeClient: LeanClient | undefined = undefined;

    private progressChangedEmitter = new EventEmitter<[string, LeanFileProgressProcessingInfo[]]>()
    progressChanged = this.progressChangedEmitter.event

    private clientAddedEmitter = new EventEmitter<LeanClient>()
    clientAdded = this.clientAddedEmitter.event

    private clientRemovedEmitter = new EventEmitter<LeanClient>()
    clientRemoved = this.clientRemovedEmitter.event

    constructor(localStorage : LocalStorageService, installer : LeanInstaller, pkgService : LeanpkgService, outputChannel : OutputChannel) {
        this.localStorage = localStorage;
        this.outputChannel = outputChannel;
        this.installer = installer;
        this.pkgService = pkgService;

        // Only change the document language for *visible* documents,
        // because this closes and then reopens the document.
        window.visibleTextEditors.forEach((e) => this.didOpenEditor(e.document));
        this.subscriptions.push(window.onDidChangeVisibleTextEditors((es) =>
            es.forEach((e) => this.didOpenEditor(e.document))));

        this.subscriptions.push(
            commands.registerCommand('lean4.refreshFileDependencies', () => this.refreshFileDependencies()),
            commands.registerCommand('lean4.restartServer', () => this.restartActiveClient())
        );

        workspace.onDidOpenTextDocument((document) => this.didOpenEditor(document));

        workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                const path = folder.uri.toString();
                const client = this.clients.get(path);
                if (client) {
                    this.clients.delete(path);
                    this.versions.delete(path);
                    client.dispose();
                    this.clientRemovedEmitter.fire(client);
                }
            }
        });

        installer.installChanged(async (uri: Uri) => {
            // This Uri could be 'undefined' in the case of a selectToolChain "reset"
            // Or it could be a package Uri in the case a lean package file was changed
            // or it could be a document Uri in the case of a command from
            // selectToolchainForActiveEditor.
            const path = uri.toString();
            if (this.testing.has(path)) {
                console.log(`Blocking re-entrancy on ${path}`);
                return;
            }
            // avoid re-entrancy since testLeanVersion can take a while.
            this.testing.set(path, true);
            try {
                // have to check again here in case elan install had --default-toolchain none.
                const [workspaceFolder, folder, packageFileUri] = findLeanPackageRoot(uri);
                const packageUri = folder ? folder : Uri.from({scheme: 'untitled'});
                const version = await installer.testLeanVersion(packageUri);
                if (version.version === '4') {
                    const [cached, client] = await this.ensureClient(uri, version);
                    if (cached && client) {
                        await client.restart();
                    }
                } else if (version.error) {
                    console.log(`Lean version not ok: ${version.error}`);
                }
            } catch (e) {
                console.log(`Exception checking lean version: ${e}`);
            }
            this.testing.delete(path);
        });

    }

    private getVisibleEditor(uri: Uri) : TextEditor | null {
        const path = uri.toString();
        for (const editor of window.visibleTextEditors) {
            if (editor.document.uri.toString() === path){
                return editor;
            }
        }
        return null;
    }

    private refreshFileDependencies() {
        if (window.activeTextEditor) {
            this.activeClient?.refreshFileDependencies(window.activeTextEditor.document);
        }
    }

    private restartActiveClient() {
        void this.activeClient?.restart();
    }

    async didOpenEditor(document: TextDocument) {
        this.pkgService.didOpen(document.uri);

        // bail as quickly as possible on non-lean files.
        if (document.languageId !== 'lean' && document.languageId !== 'lean4') {
            return;
        }

        if (!this.getVisibleEditor(document.uri)) {
            // Sometimes VS code opens a document that has no editor yet.
            // For example, this happens when the vs code opens files to get git
            // information using a "git:" Uri scheme:
            //  git:/d%3A/Temp/lean_examples/Foo/Foo/Hello.lean.git?%7B%22path%22%3A%22d%3A%5C%5CTemp%5C%5Clean_examples%5C%5CFoo%5C%5CFoo%5C%5CHello.lean%22%2C%22ref%22%3A%22%22%7D
            return;
        }

        // All open .lean files are assumed to be Lean 4 files.
        // We need to do this because by default, .lean is associated with language id `lean`,
        // i.e. Lean 3. vscode-lean is expected to yield when isLean4Project is true.
        if (document.languageId === 'lean') {
            // Only change the document language for *visible* documents,
            // because this closes and then reopens the document.
            await languages.setTextDocumentLanguage(document, 'lean4');

            // setTextDocumentLanguage triggers another didOpenEditor event,
            // and we want that event callback to be the one that calls
            // ensureClient, so we bail here so we don't try and do it twice
            // on the same document.
            return;
        }

        try {
            const [cached, client] = await this.ensureClient(document.uri, undefined);
            if (client) {
                await client.openLean4Document(document)
            }
        } catch (e) {
            console.log(`### error opening document: ${e}`);
        }
    }

    // Find the client for a given document.
    findClient(path: string){
        if (path) {
            for (const client of this.getClients()) {
                if (path.startsWith(client.getWorkspaceFolder()))
                    return client
            }
        }
        return null
    }

    getClients() : LeanClient[]{
        return Array.from(this.clients.values());
    }

    getFolderFromUri(uri: Uri) : Uri | null {
        if (uri){
            if (uri.scheme === 'untitled'){
                // this lean client can handle all untitled documents.
                return Uri.from({scheme: 'untitled'});
            }
            return uri.with({ path: path.posix.dirname(uri.path) });
        }
        return null;
    }

    async getLeanVersion(uri: Uri) : Promise<LeanVersion | undefined> {
        const [workspaceFolder, folder, packageFileUri] = findLeanPackageRoot(uri);
        const folderUri = folder ? folder : Uri.from({scheme: 'untitled'});
        const path = folderUri.toString()
        if (this.versions.has(path)){
            return this.versions.get(path);
        }
        let versionInfo : LeanVersion;
        if (uri?.scheme === 'untitled'){
            versionInfo = { version: '4', error: undefined };
        } else {
            versionInfo = await this.installer.testLeanVersion(folderUri);
        }
        this.versions.set(path, versionInfo);
        return versionInfo;
    }

    // Starts a LeanClient if the given file is in a new workspace we haven't seen before.
    // Returns a boolean "true" if the LeanClient was already created.
    // Returns a null client if it turns out the new workspace is a lean3 workspace.
    async ensureClient(uri : Uri, versionInfo: LeanVersion | undefined) : Promise<[boolean,LeanClient | undefined]> {
        const [workspaceFolder, folder, packageFileUri] = findLeanPackageRoot(uri);
        const folderUri = folder ? folder : Uri.from({scheme: 'untitled'});
        const path = folderUri.toString();
        let  client: LeanClient | undefined;
        const cachedClient = this.clients.has(path);
        if (cachedClient) {
            // we're good then
            client = this.clients.get(path);
        }
        if (!client && !this.pending.has(path)) {
            this.pending.set(path, true);
            console.log('Creating LeanClient for ' + path);

            // We must create a Client before doing the long running testLeanVersion
            // so that ensureClient callers have an "optimistic" client to work with.
            // This is needed in our constructor where it is calling ensureClient for
            // every open file.  A workspace could have multiple files open and we want
            // to remember all those open files are associated with this client before
            // testLeanVersion has completed.
            client = new LeanClient(workspaceFolder, folderUri, this.localStorage, this.outputChannel);
            this.subscriptions.push(client);
            this.clients.set(path, client);

            if (!versionInfo) {
                versionInfo = await this.getLeanVersion(folderUri);
            }
            if (versionInfo && versionInfo.version && versionInfo.version !== '4') {
                // ignore workspaces that belong to a different version of Lean.
                console.log(`Lean4 extension ignoring workspace '${folderUri}' because it is not a Lean 4 workspace.`);
                this.pending.delete(path);
                this.clients.delete(path);
                client.dispose();
                return [false, undefined];
            }

            client.serverFailed((err) => {
                // forget this client!
                const cached = this.clients.get(path);
                this.clients.delete(path);
                cached?.dispose();
                void window.showErrorMessage(err);
            });

            // aggregate progress changed events.
            client.progressChanged(arg => {
                this.progressChangedEmitter.fire(arg);
            });

            this.pending.delete(path);
            this.clientAddedEmitter.fire(client);

            if (versionInfo && !versionInfo.error) {
                // we are ready to start, otherwise some sort of install might be happening
                // as a result of UI options shown by testLeanVersion.
                await client.start();
            }
        }

        // tell the InfoView about this activated client.
        this.activeClient = client;

        return [cachedClient, client];
    }

    dispose(): void {
        for (const s of this.subscriptions) { s.dispose(); }
    }

}
