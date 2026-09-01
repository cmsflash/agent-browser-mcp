// Force a tab into the frozen lifecycle state via CDP, then prove that
// script-injection tools recover instead of hanging.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup } from "./harness.mjs";
const here = import.meta.dirname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pages = createServer((req,res)=>{ try{res.setHeader("content-type","text/html");res.end(readFileSync(join(here,"pages",req.url==="/"?"index.html":req.url.split("?")[0])))}catch{res.statusCode=404;res.end("nf")} });
await new Promise(r=>pages.listen(8962,"127.0.0.1",r));
const profile = mkdtempSync(join(tmpdir(),"cab-vf-"));
const extDir = makeTestExtension();
// remote-debugging-port lets the TEST (not the extension) freeze the tab out-of-band
const chrome = launchChrome({ extensionDir: extDir, profileDir: profile, args: ["--remote-debugging-port=9444","--window-size=1100,800","about:blank"] });
const t = new StdioClientTransport({ command:"node", args:[join(root,"server","index.mjs")], stderr:"ignore", env: serverEnv });
const c = new Client({name:"vf",version:"1.0.0"}); await c.connect(t);
const TH = "freeze-recovery test";
const call = async (name,args={}) => { const s=Date.now(); const r=await c.callTool({name,arguments:{threadTitle:TH,...args}}); const x=(r.content||[]).find(y=>y.type==="text"); let j=null; try{j=JSON.parse(x?.text||"null")}catch{j={_raw:x?.text}} return {isError:!!r.isError,json:j,ms:Date.now()-s}; };
for (let i=0;i<25;i++){const s=await call("get_status");if(!s.isError&&s.json.connected)break;await sleep(1000);}
await call("delete_my_tabs");
const g = (await call("new_tab",{url:"http://127.0.0.1:8962/index.html"})).json;
await sleep(1000);

// freeze the page from an independent CDP client
const targets = await (await fetch("http://127.0.0.1:9444/json/list")).json();
const tgt = targets.find(x => x.type === "page" && x.url.includes("index.html"));
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.on("open", r));
let id = 0;
const send = (m,p={}) => new Promise(res => { const i=++id; const h=(d)=>{const j=JSON.parse(d.toString()); if(j.id===i){ws.off("message",h);res(j);}}; ws.on("message",h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
await send("Page.enable");
const fz = await send("Page.setWebLifecycleState", { state: "frozen" });
console.log("froze the page:", JSON.stringify(fz).slice(0,80));
ws.close();  // drop our CDP session so only the extension can revive it
await sleep(500);

const r1 = await call("get_page_text", { tabId: g.tabId });
console.log(r1.isError ? `❌ get_page_text on frozen tab FAILED (${r1.ms}ms): ${JSON.stringify(r1.json).slice(0,120)}`
                       : `✅ get_page_text recovered from frozen tab (${r1.ms}ms, ${(r1.json.text||"").length} chars)`);
const r2 = await call("read_page", { tabId: g.tabId });
console.log(r2.isError ? `❌ read_page FAILED (${r2.ms}ms)` : `✅ read_page works after wake (${r2.ms}ms)`);
const r3 = await call("click", { tabId: g.tabId, selector: "#inc" });
const cnt = await call("javascript_tool", { action: "javascript_exec", text: "document.querySelector('#count').textContent", tabId: g.tabId });
console.log(!r3.isError && cnt.json.result === "1" ? "✅ interaction works after wake" : `❌ interaction broken: ${JSON.stringify(cnt.json)}`);

await call("delete_my_tabs");
await c.close(); chrome.kill(); pages.close(); cleanup([profile,extDir]); process.exit(0);
