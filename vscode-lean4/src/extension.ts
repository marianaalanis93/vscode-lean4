import { window, Uri, workspace, ExtensionContext, TextDocument } from 'vscode'
import { AbbreviationFeature } from './abbreviation'
import { InfoProvider } from './infoview'
import { DocViewProvider } from './docview';
import { LeanTaskGutter } from './taskgutter'
import { LocalStorageService} from './utils/localStorage'
import { LeanInstaller } from './utils/leanInstaller'
import { LeanpkgService } from './utils/leanpkg';
import { LeanClientProvider } from './utils/clientProvider';
import { addDefaultElanPath } from './config';
import { dirname, basename } from 'path';
import { findLeanPackageVersionInfo } from './utils/projectInfo';

function isLean(languageId : string) : boolean {
    return languageId === 'lean' || languageId === 'lean4';
}


function getLeanDocument() : TextDocument | undefined {
    let document : TextDocument | undefined;
    if (window.activeTextEditor && isLean(window.activeTextEditor.document.languageId))
    {
        document = window.activeTextEditor.document
    }
    else {
        // This happens if vscode starts with a lean file open
        // but the "Getting Started" page is active.
        for (const editor of window.visibleTextEditors) {
            const lang = editor.document.languageId;
            if (isLean(lang)) {
                document = editor.document;
                break;
            }
        }
    }
    return document;
}

export async function activate(context: ExtensionContext): Promise<any> {

    addDefaultElanPath();

    const defaultToolchain = 'leanprover/lean4:nightly';
    const outputChannel = window.createOutputChannel('Lean: Editor');
    const storageManager = new LocalStorageService(context.workspaceState);

    // migrate to new setting where it is now a directory location, not the
    // actual full file name of the lean program.
    const path = storageManager.getLeanPath();
    if (path) {
        const filename = basename(path);
        if (filename === 'lean' || filename === 'lean.exe') {
            const newPath = dirname(dirname(path)); // above the 'bin' folder.
            storageManager.setLeanPath(newPath === '.' ? '' : newPath);
        }
    }

    // note: workspace.rootPath can be undefined in the untitled or adhoc case
    // where the user ran "code lean_filename".
    const doc = getLeanDocument();
    let packageUri = null;
    let toolchainVersion = null;
    if (doc) {
        [packageUri, toolchainVersion] = await findLeanPackageVersionInfo(doc.uri);
        if (toolchainVersion && toolchainVersion.indexOf('lean:3') > 0) {
            // then this file belongs to a lean 3 project!
            return { isLean4Project: false };
        }
    }

    const installer = new LeanInstaller(outputChannel, storageManager, defaultToolchain)
    context.subscriptions.push(installer);

    const pkgService = new LeanpkgService()
    context.subscriptions.push(pkgService);

    const versionInfo = await installer.checkLeanVersion(packageUri, toolchainVersion??defaultToolchain)
    // Check whether rootPath is a Lean 3 project (the Lean 3 extension also uses the deprecated rootPath)
    if (versionInfo.version === '3') {
        context.subscriptions.pop()?.dispose(); // stop installer
        // We need to terminate before registering the LeanClientProvider,
        // because that class changes the document id to `lean4`.
        return { isLean4Project: false };
    }

    const clientProvider = new LeanClientProvider(storageManager, installer, pkgService, outputChannel);
    context.subscriptions.push(clientProvider)

    const info = new InfoProvider(clientProvider, {language: 'lean4'}, context);
    context.subscriptions.push(info)

    const abbrev = new AbbreviationFeature();
    context.subscriptions.push(abbrev);

    const docview = new DocViewProvider(context.extensionUri);
    context.subscriptions.push(docview);

    // pass the abbreviations through to the docview so it can show them on demand.
    docview.setAbbreviations(abbrev.abbreviations.symbolsByAbbreviation);

    context.subscriptions.push(new LeanTaskGutter(clientProvider, context))

    pkgService.versionChanged((uri) => installer.handleVersionChanged(uri));
    pkgService.lakeFileChanged((uri) => installer.handleLakeFileChanged(uri));

    return  { isLean4Project: true };
}
