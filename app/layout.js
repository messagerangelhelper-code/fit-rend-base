export const metadata = { title: 'Fit-Rend-Base', description: 'Your own repos, deploys and databases, behind clearance levels.' };
export const viewport = { width: 'device-width', initialScale: 1 };

const css = `
:root{--bg:#0f1419;--panel:#171e26;--panel2:#1e2731;--line:#2b3744;--text:#e7ecf1;--muted:#9fb0c0;--accent:#3fb950;--accent2:#7cc4ff;--bad:#f85149;--warn:#d29922;--orange:#f0883e}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent2)}button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}
button:hover{border-color:var(--accent2)}button.primary{background:var(--accent);border-color:var(--accent);color:#06210c;font-weight:600}
button.danger{border-color:var(--bad);color:#ffb3ae}button:disabled{opacity:.5;cursor:default}button.link{background:none;border:none;padding:0;color:var(--accent2)}
input,select,textarea{background:#0b1015;border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%;max-width:100%}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;min-height:220px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
.wrap{max-width:1100px;margin:0 auto;padding:12px 16px 60px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0 12px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:18px;margin-right:auto}.pill{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:3px 9px;color:var(--muted)}
.pill.ok{border-color:var(--accent);color:#9be9a8}.pill.warn{border-color:var(--warn);color:#f0c66b}.pill.bad{border-color:var(--bad);color:#ffb3ae}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.tabs button{border-radius:99px}.tabs button.on{background:var(--accent2);color:#04121f;border-color:var(--accent2);font-weight:600}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:10px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:0 0 auto}.grow{flex:1 1 200px!important}
.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.list{border:1px solid var(--line);border-radius:10px;overflow:hidden}.list>div{padding:9px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.list>div:last-child{border-bottom:none}.list>div.click{cursor:pointer}.list>div.click:hover,.list>div.sel{background:var(--panel2)}
.grid2{display:grid;grid-template-columns:260px 1fr;gap:12px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.tbl{overflow:auto;border:1px solid var(--line);border-radius:10px;max-height:60vh}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}th{background:var(--panel2);position:sticky;top:0}
.modal{position:fixed;inset:0;background:#000a;display:grid;place-items:center;padding:16px;z-index:50}.modal .card{width:100%;max-width:440px;max-height:90vh;overflow:auto}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--accent);padding:10px 16px;border-radius:10px;z-index:60;max-width:92vw}
.toast.bad{border-color:var(--bad)}.center{max-width:420px;margin:8vh auto}.lock{font-size:42px;text-align:center}
.diff div{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:0 6px}.diff .add{background:#12361d}.diff .del{background:#3d1517}
.keybox{display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}.keybox .keyline,.keybox .keyarea{flex:1 1 220px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.keybox .keyarea{min-height:110px;word-break:break-all}button.icon{padding:8px 10px;line-height:1}
/* Every other button is orange, so buttons side by side are easy to tell apart. Red (delete) buttons stay red. */
:is(.row,.top,.gd-nav,.gd-tiles,.keybox,.box,.all,.list>div)>button:nth-of-type(even):not(.danger):not(.link):not(.pill){background:var(--orange);border-color:var(--orange);color:#2b1400;font-weight:600}
.top>button.pill:nth-of-type(even){border-color:var(--orange);color:#ffc08a}
/* Pipeline board: one column per stage, side by side; scrolls sideways on a phone. */
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);gap:10px;overflow-x:auto;padding-bottom:8px}.board .col{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:8px;min-height:120px}.board .col .card{margin:8px 0;padding:10px}
h2{font-size:18px;margin:6px 0 10px}h3{font-size:15px;margin:14px 0 8px}code{background:#0b1015;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:13px}
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head><style dangerouslySetInnerHTML={{ __html: css }} /></head>
      <body>{children}</body>
    </html>
  );
}
