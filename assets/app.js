const API='';
function authToken(){try{return localStorage.getItem('atolle_token')||''}catch(e){return ''}}
function setAuth(token,user){try{if(token)localStorage.setItem('atolle_token',token);else localStorage.removeItem('atolle_token');if(user)localStorage.setItem('atolle_user',JSON.stringify(user));else localStorage.removeItem('atolle_user')}catch(e){}}
async function api(path,opt={}){
  const token=authToken();
  const headers={'Content-Type':'application/json',...(token?{'Authorization':'Bearer '+token}:{}),...(opt.headers||{})};
  const r=await fetch(API+path,{...opt,headers});
  let d={};try{d=await r.json()}catch(e){}
  if(!r.ok){const err=new Error(d.error||'Request failed');err.status=r.status;throw err}return d
}
async function requirePageAuth(roles=[]){
  try{const h=await api('/api/health');if(!h.auth_enforced)return {role:roles[0]||'guest',demo:true};const me=await api('/api/auth/me');if(roles.length&&!roles.includes(me.role))throw Object.assign(new Error('Access denied'),{status:403});return me}
  catch(e){if(e.status===401||e.status===403){const next=encodeURIComponent(location.pathname+location.search);location.href='login.html?next='+next;return null}throw e}
}
async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch(e){}setAuth('');location.href='index.html'}
function money(n){if(n===null||n===undefined||n==='')return '—';return '$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}
function esc(s=''){return String(s).replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[m]))}
function yachtCard(y){let modes=[];if(y.private_enabled)modes.push('Private charter');if(y.shared_enabled)modes.push('Shared cruise');const p=y.private_enabled&&y.private_rate?`${money(y.private_rate)} / night`:y.shared_rate?`${money(y.shared_rate)} / person`:'Request price';return `<a class="card" href="yacht.html?id=${y.id}"><div class="imageWrap"><img src="${esc(y.image)}" alt="${esc(y.name)}"><span class="cardBadge">${y.verified?'✓ Verified yacht':'New listing'}</span><button class="heart" type="button" aria-label="Save yacht" onclick="event.preventDefault();this.textContent=this.textContent==='♡'?'♥':'♡'">♡</button></div><div class="cardbody"><div>${modes.map(m=>`<span class="tag">${m}</span>`).join('')}</div><h3>${esc(y.name)}</h3><div class="spec">${esc(y.type)} · ${y.guests} guests · ${y.cabins} cabins · ${y.length_m||'—'}m</div><div class="price"><div><small class="muted">From</small><br><strong>${p}</strong></div><div class="rating">★ ${y.rating||'New'} <span class="muted">(${y.reviews||0})</span></div></div></div></a>`}
