/** 汐控制台：单页只读状态面板（数据来自 /api/xi-console/status）。 */
export function consoleHtml() {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>汐的状态</title><style>
body{margin:0;background:#0b1020;color:#e8f0ff;font:14px/1.6 system-ui,sans-serif}header{padding:18px 20px;border-bottom:1px solid #1e2a4a;display:flex;justify-content:space-between;align-items:center}h1{font-size:18px;margin:0}small{color:#8fa8d8}
main{padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#121a30;border:1px solid #22345c;border-radius:12px;padding:14px}.card h2{font-size:14px;color:#9fc1ff;margin:0 0 8px}.row{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed #1e2a4a;padding:4px 0}.muted{color:#7f93b8}.pill{background:#1d2b4d;border-radius:999px;padding:1px 8px;margin-right:4px;font-size:12px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#b9c9e6}
body.embed header{display:none}body.embed #settings{display:none}body.embed main{padding:0}body.embed{background:transparent}
</style><header><h1>汐的状态</h1><small id="ts">加载中…</small></header><main id="root"></main><section id="settings" class="card" style="margin:16px"><h2>设置（人格 / 记忆 / 生活）</h2><p class="muted">保存后需重启 DSH 生效；只列出可编辑字段。</p><div id="settings-body">加载中…</div></section>
<script>
const fmt=(x)=>x==null?'—':typeof x==='object'?JSON.stringify(x):String(x);
const EMBED=new URLSearchParams(location.search).get('embed')==='1';
if(EMBED)document.body.classList.add('embed');
if(EMBED)document.getElementById('settings').style.display='none';
async function tick(){try{const r=await fetch('/api/xi-console/status',{cache:'no-store'});const j=await r.json();document.getElementById('ts').textContent=new Date(j.at).toLocaleString();
 const p=j.persona||{},m=j.memory||{},l=j.life||{};
 const ep=(p.episodes||[]).map(e=>\`<span class="pill">\${e.emotion} \${Number(e.intensity).toFixed(2)}</span>\`).join('');
 const st=p.state||{};
 const drives=(l.drives||[]).map(d=>\`<span class="pill">\${d.name} \${Number(d.value).toFixed(2)}</span>\`).join('');
 document.getElementById('root').innerHTML=\`
 <div class="card"><h2>人格与情绪</h2><div class="row"><span>当前情绪</span><b>\${fmt(st.label)} · \${Number(st.intensity||0).toFixed(2)}</b></div>
 <div class="row"><span>正在生效的情绪</span><span>\${ep||'<span class="muted">无</span>'}</span></div>
 <div class="row"><span>情绪值（好感 / 激动）</span><span>\${Number(st.valence||0).toFixed(2)} / \${Number(st.arousal||0).toFixed(2)}</span></div>
 <div class="row"><span>精力 / 社交</span><span>\${Number(st.energy||0).toFixed(2)} / \${Number(st.social||0).toFixed(2)}</span></div>
 <div class="row"><span>性格底色</span><span>\${(p.axes||[]).map(a=>\`\${a.axis} \${Number(a.value).toFixed(2)}\`).join(' · ')||'—'}</span></div>
 <div class="row"><span>还没说开的矛盾</span><span>\${(p.grievances||[]).map(g=>g.cause).join('；')||'—'}</span></div></div>
 <div class="card"><h2>记忆</h2><div class="row"><span>可用记忆</span><b>\${m.active??'—'}</b></div>
 <div class="row"><span>最近三天</span><div>\${(m.shortterm||[]).map(s=>\`<div>· \${s.content}</div>\`).join('')||'<span class="muted">空</span>'}</div></div>
 <div class="row"><span>主人画像</span><div>\${m.profile?.summary?m.profile.summary:'<span class="muted">空</span>'}</div></div>
 <div class="row"><span>上次日结</span><pre>\${fmt(m.lastConsolidate)}</pre></div></div>
 <div class="card"><h2>生活与主动</h2><div class="row"><span>驱力</span><span>\${drives||'—'}</span></div>
 <div class="row"><span>家的会话</span><span>\${fmt(l.home?.home_session_id)}</span></div>
 <div class="row"><span>上下文用量（tokens）</span><span>\${fmt(l.home?.prompt_tokens)}</span></div>
 <div class="row"><span>最近醒来</span><pre>\${fmt(l.lastWake)}</pre></div>
 <div class="row"><span>最近做的事</span><div>\${(l.actions||[]).map(a=>\`<div>· \${a.kind} \${a.status}</div>\`).join('')||'<span class="muted">空</span>'}</div></div></div>
 <div class="card"><h2>改设置</h2><p class="muted">设置仍在 DSH「设置 → 汐」里改；本页只读状态。保存设置后重启 DSH 生效。</p><p><a style="color:#9fc1ff" href="/" target="_blank">回到 DSH</a></p></div>\`}catch(e){document.getElementById('ts').textContent='读取失败：'+e.message}}

const NS_CN={ 'persona-core':'人格','memory-core':'记忆',autonomy:'生活' };
const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const flat=(obj,path=[],out=[]) => { for (const [k,v] of Object.entries(obj||{})) { const p=[...path,k]; if (v && typeof v==='object' && !Array.isArray(v)) flat(v,p,out); else out.push({path:p,value:v}); } return out; };
async function loadSettings(){try{const r=await fetch('/api/xi/settings',{cache:'no-store'});const j=await r.json();const box=document.getElementById('settings-body');if(!j.ok){box.textContent='设置服务不可用';return}
 let html='';for(const row of j.rows){const items=flat(row.value);html+=\`<h3>\${NS_CN[row.ns]||row.ns}</h3><div class="settings" data-ns="\${row.ns}" data-rev="\${row.revision}">\`;for(const it of items){const id=\`s-\${row.ns}-\${it.path.join('-')}\`;const v=it.value;const label=it.path.slice(1).join('.')||it.path.join('.');
 if(typeof v==='boolean') html+=\`<label class="row"><span>\${label}</span><input type="checkbox" data-path="\${it.path.join('.')}" \${v?'checked':''}></label>\`;
 else if(typeof v==='number') html+=\`<label class="row"><span>\${label}</span><input type="number" step="any" data-path="\${it.path.join('.')}" value="\${v}"></label>\`;
 else if(typeof v==='string') html+=\`<label class="row"><span>\${label}</span><input type="text" data-path="\${it.path.join('.')}" value="\${esc(v)}"></label>\`;}
 html+=\`<p><button data-save="\${row.ns}">保存 \${NS_CN[row.ns]||row.ns}</button> <span class="muted" data-msg="\${row.ns}"></span></p></div>\`;}
 box.innerHTML=html;for(const btn of box.querySelectorAll('button[data-save]'))btn.onclick=()=>saveSettings(btn.dataset.save);}catch(e){document.getElementById('settings-body').textContent='读取失败：'+e.message}}
async function saveSettings(ns){const box=document.querySelector(\`.settings[data-ns="\${ns}"]\`);if(!box)return;const ops=[];for(const el of box.querySelectorAll('[data-path]')){const path=el.dataset.path.split('.');let v;if(el.type==='checkbox')v=el.checked;else if(el.type==='number')v=Number(el.value);else v=el.value;ops.push({op:'set',path,value:v})}
 const msg=box.querySelector('[data-msg]');msg.textContent='保存中…';const r=await fetch('/api/xi/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ns,revision:Number(box.dataset.rev),operations:ops})});const j=await r.json();msg.textContent=j.ok?'已保存（重启生效）':('失败：'+(j.error||r.status));if(j.ok)loadSettings();}
loadSettings();
tick();setInterval(tick,5000);setInterval(tick,5000);
</script></html>`
}
