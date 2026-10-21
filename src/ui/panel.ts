import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from './protocol';

/** The "AVR Board & I/O" webview. One per window; survives debug sessions. */
export class Panel {
  private panel?: vscode.WebviewPanel;
  private last?: ToWebview;

  constructor(private readonly extUri: vscode.Uri, private readonly onMessage: (m: FromWebview) => unknown) {}

  show(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside, true); return; }
    const media = vscode.Uri.joinPath(this.extUri, 'media');
    const p = vscode.window.createWebviewPanel('avrBoard', 'AVR Board & I/O',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const uri = (f: string) => p.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = Math.random().toString(36).slice(2);
    p.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('panel.css')}"><title>AVR Board &amp; I/O</title></head>
<body><div id="status" role="status"></div><section id="board" aria-label="Virtual lab board"></section>
<section id="io" aria-label="I/O registers"></section>
<script nonce="${nonce}" src="${uri('panel.js')}"></script></body></html>`;
    p.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready' && this.last) p.webview.postMessage(this.last);
      else this.onMessage(m);
    });
    p.onDidDispose(() => (this.panel = undefined));
    this.panel = p;
  }

  post(msg: ToWebview): void {
    this.last = msg;
    this.panel?.webview.postMessage(msg);
  }
}
