import { join } from 'path';
import {
    commands, Disposable, DocumentSelector,
    ExtensionContext, languages, Range,
    Selection, TextEditor, TextEditorRevealType,
    Uri, ViewColumn, WebviewPanel, window, workspace, env, Position,
} from 'vscode';
import { EditorApi, InfoviewApi, LeanFileProgressParams, TextInsertKind, RpcConnectParams, RpcConnected, RpcKeepAliveParams } from '@lean4/infoview-api';
import { LeanClient } from './leanclient';
import { getInfoViewAllErrorsOnLine, getInfoViewAutoOpen, getInfoViewAutoOpenShowGoal,
    getInfoViewFilterIndex, getInfoViewStyle, getInfoViewTacticStateFilters } from './config';
import { Rpc } from './rpc';
import { LeanClientProvider } from './utils/clientProvider'
import * as ls from 'vscode-languageserver-protocol'

const keepAlivePeriodMs = 10000

async function rpcConnect(client: LeanClient, uri: ls.DocumentUri): Promise<string> {
    const connParams: RpcConnectParams = { uri };
    const result: RpcConnected = await client.sendRequest('$/lean/rpc/connect', connParams);
    return result.sessionId;
}

class RpcSession implements Disposable {
    keepAliveInterval?: NodeJS.Timeout;
    client : LeanClient;

    constructor(client: LeanClient, public sessionId: string, public uri: ls.DocumentUri) {
        this.client = client;
        this.keepAliveInterval = setInterval(() => {
            const params: RpcKeepAliveParams = { uri, sessionId }
            try {
                client.sendNotification('$/lean/rpc/keepAlive', params)
            } catch (e) {
                console.log(`failed to send keepalive for ${uri}`, e)
                if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
            }
        }, keepAlivePeriodMs)
    }

    dispose() {
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
        // TODO: at this point we could close the session
    }
}

export class InfoProvider implements Disposable {
    /** Instance of the panel, if it is open. Otherwise `undefined`. */
    private webviewPanel?: WebviewPanel & {rpc: Rpc, api: InfoviewApi};
    private subscriptions: Disposable[] = [];
    private clientSubscriptions: Disposable[] = [];

    private stylesheet: string = '';
    private autoOpened: boolean = false;
    private clientProvider: LeanClientProvider;

    // Subscriptions are counted and only disposed of when count becomes 0.
    private serverNotifSubscriptions: Map<string, [number, Disposable[]]> = new Map();
    private clientNotifSubscriptions: Map<string, [number, Disposable[]]> = new Map();

    private rpcSessions: Map<string, RpcSession> = new Map();

    private subscribeDidChangeNotification(client: LeanClient, method: string){
        const h = client.didChange((params) => {
            void this.webviewPanel?.api.sentClientNotification(method, params);
        });
        return h;
    }

    private subscribeDidCloseNotification(client: LeanClient, method: string){
        const h = client.didClose((params) => {
            void this.webviewPanel?.api.sentClientNotification(method, params);
        });
        return h;
    }

    private subscribeDiagnosticsNotification(client: LeanClient, method: string){
        const h = client.diagnostics((params) => {
            void this.webviewPanel?.api.gotServerNotification(method, params);
        });
        return h;
    }

    private subscribeCustomNotification(client: LeanClient, method: string){
        const h = client.customNotification(({method: thisMethod, params}) => {
            if (thisMethod !== method) return;
            void this.webviewPanel?.api.gotServerNotification(method, params);
        });
        return h;
    }

    private editorApi : EditorApi = {
        sendClientRequest: async (uri: string, method: string, params: any): Promise<any> => {
            const client = this.clientProvider.findClient(uri);
            if (client) {
                return client.sendRequest(method, params);
            }
            return undefined;
        },
        sendClientNotification: async (uri: string, method: string, params: any): Promise<void> => {
            const client = this.clientProvider.findClient(uri);
            if (client) {
                client.sendNotification(method, params);
            }
        },
        subscribeServerNotifications: async (method) => {
            const el = this.serverNotifSubscriptions.get(method);
            if (el) {
                const [count, h] = el;
                this.serverNotifSubscriptions.set(method, [count + 1, h]);
                return;
            }

            // NOTE(WN): For non-custom notifications we cannot call LanguageClient.onNotification
            // here because that *overwrites* the notification handler rather than registers an extra one.
            // So we have to add a bunch of event emitters to `LeanClient.`
            if (method === 'textDocument/publishDiagnostics') {
                const subscriptions : Disposable[] = [];
                for (const client of this.clientProvider.getClients()) {
                    subscriptions.push(this.subscribeDiagnosticsNotification(client, method));
                }
                this.serverNotifSubscriptions.set(method, [1, subscriptions]);
            } else if (method.startsWith('$')) {
                const subscriptions : Disposable[] = [];
                for (const client of this.clientProvider.getClients()) {
                    subscriptions.push(this.subscribeCustomNotification(client, method));
                }
                this.serverNotifSubscriptions.set(method, [1, subscriptions]);
            } else {
                throw new Error(`subscription to ${method} server notifications not implemented`);
            }
        },
        unsubscribeServerNotifications: async (method) => {
            const el = this.serverNotifSubscriptions.get(method);
            if (!el) throw new Error(`trying to unsubscribe from '${method}' with no active subscriptions`);
            const [count, subscriptions] = el;
            if (count === 1) {
                for (const h of subscriptions){
                    h.dispose();
                }
                this.serverNotifSubscriptions.delete(method);
            } else {
                this.serverNotifSubscriptions.set(method, [count - 1, subscriptions])
            }
        },

        subscribeClientNotifications: async (method) => {
            const el = this.clientNotifSubscriptions.get(method);
            if (el) {
                const [count, d] = el;
                this.clientNotifSubscriptions.set(method, [count + 1, d]);
                return;
            }

            if (method === 'textDocument/didChange') {
                const subscriptions : Disposable[] = [];
                for (const client of this.clientProvider.getClients()) {
                    subscriptions.push(this.subscribeDidChangeNotification(client, method));
                }
                this.clientNotifSubscriptions.set(method, [1, subscriptions]);
            } else if (method === 'textDocument/didClose') {
                const subscriptions : Disposable[] = [];
                for (const client of this.clientProvider.getClients()) {
                    subscriptions.push(this.subscribeDidCloseNotification(client, method))
                }
                this.clientNotifSubscriptions.set(method, [1,subscriptions]);
            } else {
                throw new Error(`Subscription to '${method}' client notifications not implemented`);
            }
        },

        unsubscribeClientNotifications: async (method) => {
            const el = this.clientNotifSubscriptions.get(method);
            if (!el) throw new Error(`trying to unsubscribe from '${method}' with no active subscriptions`);
            const [count, subscriptions] = el;
            if (count === 1) {
                for (const d of subscriptions) {
                    d.dispose();
                }
                this.clientNotifSubscriptions.delete(method);
            } else {
                this.clientNotifSubscriptions.set(method, [count - 1, subscriptions])
            }
        },
        copyToClipboard: async (text) => {
            await env.clipboard.writeText(text);
            await window.showInformationMessage(`Copied to clipboard: ${text}`);
        },
        insertText: async (text, kind, tdpp) => {
            if (tdpp) {
                const client = this.clientProvider.findClient(tdpp.textDocument.uri);
                if (!client?.running) return;
                const uri = client.convertUriFromString(tdpp.textDocument.uri);
                const pos = client.convertPosition(tdpp.position);
                await this.handleInsertText(text, kind, uri, pos);
            }
        },
        showDocument: async (show) => {
            const client = this.clientProvider.findClient(show.uri);
            if (!client?.running) return;
            void this.revealEditorSelection(
                Uri.parse(show.uri),
                client.convertRange(show.selection)
            );
        },

        createRpcSession: async uri => {
            const client = this.clientProvider.findClient(uri);
            if (!client) return '';
            const sessionId = await rpcConnect(client, uri);
            const session = new RpcSession(client, sessionId, uri);
            if (!this.webviewPanel) {
                session.dispose();
                throw Error('infoview disconnect while connecting to RPC session');
            } else {
                this.rpcSessions.set(sessionId, session);
                return sessionId;
            }
        },
        closeRpcSession: async sessionId => {
            const session = this.rpcSessions.get(sessionId);
            if (session) {
                this.rpcSessions.delete(sessionId);
                session.dispose();
            }
        },
    };

    constructor(private provider: LeanClientProvider, private readonly leanDocs: DocumentSelector, private context: ExtensionContext) {
        this.clientProvider = provider;
        this.updateStylesheet();

        provider.clientAdded((client) => {
            void this.onClientAdded(client);
        });

        provider.clientRemoved((client) => {
            void this.onClientRemoved(client);
        });

        this.subscriptions.push(
            window.onDidChangeActiveTextEditor(() => this.sendPosition()),
            window.onDidChangeTextEditorSelection(() => this.sendPosition()),
            workspace.onDidChangeConfiguration(async (_e) => {
                // regression; changing the style needs a reload. :/
                this.updateStylesheet();
                await this.sendConfig();
            }),
            workspace.onDidChangeTextDocument(async () => {
                await this.sendPosition();
            }),
            commands.registerTextEditorCommand('lean4.displayGoal', (editor) => this.openPreview(editor)),
            commands.registerTextEditorCommand('lean4.displayList', async (editor) => {
                await this.openPreview(editor);
                await this.webviewPanel?.api.requestedAction({kind: 'toggleAllMessages'});
            }),
            commands.registerTextEditorCommand('lean4.infoView.copyToComment',
                () => this.webviewPanel?.api.requestedAction({kind: 'copyToComment'})),
            commands.registerCommand('lean4.infoView.toggleUpdating', () =>
                this.webviewPanel?.api.requestedAction({kind: 'togglePaused'})),
            commands.registerTextEditorCommand('lean4.infoView.toggleStickyPosition',
                () => this.webviewPanel?.api.requestedAction({kind: 'togglePin'})),
        );
    }

    private async onClientRestarted(client: LeanClient){

        if (client.isStarted()) {
            void this.autoOpen();
        }

        // Inform the infoview about the restart
        // (this is redundant if the infoview was auto-opened but it doesn't hurt)
        if (client.initializeResult) {
            await this.webviewPanel?.api.serverRestarted(client.initializeResult);
        }

        // if we already have subscriptions for a previous client, we need to also
        // subscribe to the same things on this new client.
        for (const [method, [count, subscriptions]] of this.clientNotifSubscriptions) {
            if (method === 'textDocument/didChange'){
                subscriptions.push(this.subscribeDidChangeNotification(client, method))
            } else if (method === 'textDocument/didClose'){
                subscriptions.push(this.subscribeDidCloseNotification(client, method))
            }
        }

        for (const [method, [count, subscriptions]] of this.serverNotifSubscriptions) {
            if (method === 'textDocument/publishDiagnostics'){
                subscriptions.push(this.subscribeDiagnosticsNotification(client, method))
            } else if (method.startsWith('$')){
                subscriptions.push(this.subscribeCustomNotification(client, method))
            }
        }

        // force infoview to fully update state from newly activated LeanClient.
        await this.sendPosition();
        await this.sendConfig();
        await this.sendDiagnostics(client);
        await this.sendProgress(client);
    }

    private async onClientAdded(client: LeanClient) {

        console.log(`Adding client for workspace: ${client.getWorkspaceFolder()}`);

        this.clientSubscriptions.push(
            client.restarted(async () => {
                // This event is triggered both the first time the server starts
                // as well as when the server restarts.

                this.clearRpcSessions(client);

                // Need to fully re-initialize this newly restarted client with all the
                // existing subscriptions and resend position info and so on so the
                // infoview updates properly.
                await this.onClientRestarted(client);
            }),
            client.didSetLanguage(() => this.onLanguageChanged()),
        );

        // Note that when new client is first created it still fires client.restarted
        // event, so all onClientRestarted can happen there so we don't do it twice.
    }

    onClientRemoved(client: LeanClient) {
        // todo: remove subscriptions for this client...
    }

    dispose(): void {
        // active client is changing.
        this.clearNotificationHandlers();
        this.clearRpcSessions(null);
        for (const s of this.clientSubscriptions) { s.dispose(); }
        for (const s of this.subscriptions) { s.dispose(); }
    }

    private updateStylesheet() {
        const fontFamily = workspace.getConfiguration('editor').get<string>('fontFamily')?.replace(/['"]/g, '');
        const fontCodeCSS = `
            .font-code {
                font-family: ${fontFamily};
                font-size: ${workspace.getConfiguration('editor').get('fontSize')}px;
            }
        `;
        const configCSS = getInfoViewStyle();
        this.stylesheet = fontCodeCSS + configCSS;
    }

    private async autoOpen() {
        if (!this.webviewPanel && !this.autoOpened && getInfoViewAutoOpen() && window.activeTextEditor) {
            // only auto-open for lean files, not for markdown.
            if (languages.match(this.leanDocs, window.activeTextEditor.document)) {
                // remember we've auto opened during this session so if user closes it it remains closed.
                this.autoOpened = true;
                await this.openPreview(window.activeTextEditor);
            }
        }
    }

    private clearNotificationHandlers() {
        for (const [, [, subscriptions]] of this.clientNotifSubscriptions)
            for (const h of subscriptions) h.dispose();
        this.clientNotifSubscriptions.clear();
        for (const [, [, subscriptions]] of this.serverNotifSubscriptions)
            for (const h of subscriptions) h.dispose();
        this.serverNotifSubscriptions.clear();
    }

    private clearRpcSessions(client: LeanClient | null) {
        const remaining = new Map()
        for (const [sessionId, sess] of this.rpcSessions) {
            if (client === null || sess.client === client) {
                sess.dispose();
            } else {
                remaining.set(sessionId, sess);
            }
        }
        this.rpcSessions = remaining
    }

    private async openPreview(editor: TextEditor) {
        let column = editor && editor.viewColumn ? editor.viewColumn + 1 : ViewColumn.Two;
        if (column === 4) { column = ViewColumn.Three; }
        if (this.webviewPanel) {
            this.webviewPanel.reveal(column, true);
        } else {
            const webviewPanel = window.createWebviewPanel('lean4', 'Lean Infoview',
                { viewColumn: column, preserveFocus: true },
                {
                    enableFindWidget: true,
                    retainContextWhenHidden: true,
                    enableScripts: true,
                    enableCommandUris: true,
                }) as WebviewPanel & {rpc: Rpc, api: InfoviewApi};

            // Note that an extension can send data to its webviews using webview.postMessage().
            // This method sends any JSON serializable data to the webview. The message is received
            // inside the webview through the standard message event.
            // The receiving of these messages is done inside webview\index.ts where it
            // calls window.addEventListener('message',...
            webviewPanel.rpc = new Rpc(m => webviewPanel.webview.postMessage(m));
            webviewPanel.rpc.register(this.editorApi);

            // Similarly, we can received data from the webview by listening to onDidReceiveMessage.
            webviewPanel.webview.onDidReceiveMessage(m => webviewPanel.rpc.messageReceived(m))
            webviewPanel.api = webviewPanel.rpc.getApi();
            webviewPanel.onDidDispose(() => {
                this.clearNotificationHandlers();
                this.webviewPanel = undefined;
                this.clearRpcSessions(null); // should be after `webviewPanel = undefined`
            });
            this.webviewPanel = webviewPanel;
            webviewPanel.webview.html = this.initialHtml();

            const loc = this.getLocation(editor);
            if (loc) {
                await webviewPanel.api.initialize(loc);
            }

            // The infoview gets information about file progress, diagnostics, etc.
            // by listening to notifications.  Send these notifications when the infoview starts
            // so that it has up-to-date information.
            const client = this.clientProvider.findClient(editor.document?.uri?.toString());
            if (client?.initializeResult) {
                await this.webviewPanel.api.serverRestarted(client?.initializeResult);
            }

            // await this.sendPosition();
            // await this.sendConfig();
            // await this.sendDiagnostics();
            // await this.sendProgress();
        }
    }

    private async sendConfig() {
       await this.webviewPanel?.api.changedInfoviewConfig({
           infoViewTacticStateFilters: getInfoViewTacticStateFilters(),
           filterIndex: getInfoViewFilterIndex(),
           infoViewAllErrorsOnLine: getInfoViewAllErrorsOnLine(),
           infoViewAutoOpenShowGoal: getInfoViewAutoOpenShowGoal(),
       });
    }

    private async sendDiagnostics(client: LeanClient) {
        const panel = this.webviewPanel;
        if (panel) {
            client.getDiagnostics()?.forEach(async (uri, diags) => {
                const params = client.getDiagnosticParams(uri, diags)
                await panel.api.gotServerNotification('textDocument/publishDiagnostics', params);
            });
        }
    }

    private async sendProgress(client: LeanClient) {
        if (!this.webviewPanel) return;
        for (const [uri, processing] of client.progress) {
            const params: LeanFileProgressParams = {
                textDocument: {
                    uri: client.convertUri(uri)?.toString(),
                    version: 0, // HACK: The infoview ignores this
                },
                processing,
            };
            await this.webviewPanel.api.gotServerNotification('$/lean/fileProgress', params);
        }
    }

    private onLanguageChanged() {
        void this.autoOpen();
        void this.sendPosition();
    }

    private getLocation(editor : TextEditor) : ls.Location | undefined {
        if (!editor) return undefined;
        const uri = editor.document.uri;
        const selection = editor.selection;
        return {
            uri: uri.toString(),
            range: {
                start: selection.start,
                end: selection.end
            }
        };
    }

    private async sendPosition() {
        if (!window.activeTextEditor) return
        const loc = this.getLocation(window.activeTextEditor);
        if (languages.match(this.leanDocs, window.activeTextEditor.document) === 0){
            // language is not yet 'lean4', but the LeanClient will fire the didSetLanguage event
            // in openLean4Document and that's when we can send the position to update the
            // InfoView for the newly opened document.
            return;
        }
        await this.autoOpen();
        await this.webviewPanel?.api.changedCursorLocation(loc);
    }

    private async revealEditorSelection(uri: Uri, selection?: Range) {
        let editor: TextEditor | undefined;
        for (const e of window.visibleTextEditors) {
            if (e.document.uri.toString() === uri.toString()) {
                editor = e;
                break;
            }
        }
        if (!editor) {
            const c = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;
            editor = await window.showTextDocument(uri, { viewColumn: c, preserveFocus: false });
        }
        if (selection !== undefined) {
            editor.revealRange(selection, TextEditorRevealType.InCenterIfOutsideViewport);
            editor.selection = new Selection(selection.start, selection.end);
            // ensure the text document has the keyboard focus.
            void window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
        }
    }

    private async handleInsertText(text: string, kind: TextInsertKind, uri?: Uri, pos?: Position) {
        let editor: TextEditor | undefined
        if (uri) {
           editor = window.visibleTextEditors.find(e => e.document.uri === uri);
        } else {
            editor = window.activeTextEditor;
            if (!editor) { // sometimes activeTextEditor is null.
                editor = window.visibleTextEditors.find(e => e.document.languageId === 'lean4');
            }
        }
        if (!editor) {
            // user must have switch away from any lean source file in which case we don't know
            // what to do here.  TODO: show a popup error?  Or should we use the last uri used in
            // sendPosition and automatically activate that editor?
            return;
        }
        pos = pos ? pos : editor.selection.active;
        if (kind === 'above') {
            // in this case, assume that we actually want to insert at the same
            // indentation level as the neighboring text
            const prev_line = editor.document.lineAt(pos.line - 1);
            const spaces = prev_line.firstNonWhitespaceCharacterIndex;
            const margin_str = [...Array(spaces).keys()].map(x => ' ').join('');

            let new_command = text.replace(/\n/g, '\n' + margin_str);
            new_command = `\n${margin_str}${new_command}`;

            await editor.edit((builder) => {
                builder.insert(prev_line.range.end, new_command);
            });
            editor.selection = new Selection(pos.line, spaces, pos.line, spaces);
        } else {
            await editor.edit((builder) => {
                if (pos) builder.insert(pos, text);
            });
            editor.selection = new Selection(pos, pos)
        }
    }

    private getMediaPath(mediaFile: string): string | undefined {
        if (this.webviewPanel) {
            return this.webviewPanel.webview.asWebviewUri(
                Uri.file(join(this.context.extensionPath, 'media', mediaFile))).toString();
        }
        return undefined;
    }

    private initialHtml() {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-type" content="text/html;charset=utf-8">
                <title>Infoview</title>
                <style>${this.stylesheet}</style>
            </head>
            <body>
                <div id="react_root"></div>
                <script src="${this.getMediaPath('webview.js')}"></script>
            </body>
            </html>`
    }
}
