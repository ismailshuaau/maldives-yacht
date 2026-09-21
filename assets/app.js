const API='';
function authToken(){try{return sessionStorage.getItem('atolle_token')||''}catch{return ''}}
function setAuth(token,user){try{localStorage.removeItem('atolle_token');localStorage.removeItem('atolle_user');if(token)sessionStorage.setItem('atolle_token',token);else sessionStorage.removeItem('atolle_token');if(user)sessionStorage.setItem('atolle_user',JSON.stringify(user));else sessionStorage.removeItem('atolle_user')}catch(e){}}
async function api(path,opt={}){
  const token=authToken();
  const headers={'Content-Type':'application/json',...(token?{'Authorization':'Bearer '+token}:{}),...(opt.headers||{})};
  const r=await fetch(API+path,{...opt,headers});
  let d={};try{d=await r.json()}catch(e){}
  if(!r.ok){const err=new Error(d.error||'Request failed');err.status=r.status;throw err}if(path==='/api/bookings'&&opt.method==='POST'&&d.booking_ref&&d.booking_token){try{sessionStorage.setItem('atolle_pending_claim',JSON.stringify({booking_ref:d.booking_ref,booking_token:d.booking_token}))}catch{}}return d
}
async function requirePageAuth(roles=[]){
  try{const h=await api('/api/health');if(!h.auth_enforced)return {role:roles[0]||'guest',demo:true};const me=await api('/api/auth/me');if(roles.length&&!roles.includes(me.role))throw Object.assign(new Error('Access denied'),{status:403});return me}
  catch(e){if(e.status===401||e.status===403){const next=encodeURIComponent(location.pathname+location.search);location.href='login.html?next='+next;return null}throw e}
}
async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch(e){}setAuth('');location.href='index.html'}
function money(n){if(n===null||n===undefined||n==='')return '—';return '$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}
function esc(s=''){return String(s).replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[m]))}
function privateNightRules(y){const parts=[];if(y.private_min_nights)parts.push(`Minimum ${y.private_min_nights} night${Number(y.private_min_nights)===1?'':'s'}`);if(y.private_max_nights)parts.push(`Maximum ${y.private_max_nights} night${Number(y.private_max_nights)===1?'':'s'}`);return parts.join(' · ')}
function showItinerary(departure){
  const existing=document.getElementById('itineraryModal');if(existing)existing.remove();
  const days=Array.isArray(departure.itinerary)?departure.itinerary:[];const lastFocus=document.activeElement;
  const modal=document.createElement('div');modal.id='itineraryModal';modal.className='itineraryModal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','itineraryModalTitle');
  const fallback=`<div class="itineraryFallback"><strong>${esc(departure.title||'Maldives liveaboard')}</strong><p>${esc(departure.nights||'—')} nights, from ${esc(departure.start_date||'—')} to ${esc(departure.end_date||'—')}. The operator will confirm the detailed route before departure.</p></div>`;
  modal.innerHTML=`<div class="itineraryModalCard"><header><div><p class="eyebrow">Sailing itinerary</p><h2 id="itineraryModalTitle">${esc(departure.title||'Maldives liveaboard')}</h2></div><button class="itineraryClose" type="button" aria-label="Close itinerary">×</button></header><div class="itineraryMeta"><div><span>Departure</span><strong>${esc(departure.start_date||'—')}</strong></div><div><span>Arrival</span><strong>${esc(departure.end_date||'—')}</strong></div><div><span>Embarkation</span><strong>${esc(departure.embarkation||'To be confirmed')}</strong></div><div><span>Disembarkation</span><strong>${esc(departure.disembarkation||'To be confirmed')}</strong></div><div><span>From</span><strong>${money(departure.price_pp)} / person</strong></div><div><span>Availability</span><strong>${esc(departure.places_remaining??'Contact operator')} places</strong></div></div><div class="itineraryTimeline">${days.length?days.slice().sort((a,b)=>Number(a.day)-Number(b.day)).map(day=>`<article><span>Day ${esc(day.day)}</span><div><h3>${esc(day.title||'At sea')}</h3>${Array.isArray(day.locations)&&day.locations.length?`<p class="itineraryLocations">${day.locations.map(esc).join(' · ')}</p>`:''}<p>${esc(day.description||'')}</p></div></article>`).join(''):fallback}</div><p class="itineraryDisclaimer">Routes and activities may change with weather, sea conditions, safety requirements, and local guidance. The captain’s decision is final.</p></div>`;
  const close=()=>{modal.remove();document.body.classList.remove('modalOpen');if(lastFocus instanceof HTMLElement)lastFocus.focus()};
  modal.querySelector('.itineraryClose').addEventListener('click',close);modal.addEventListener('click',event=>{if(event.target===modal)close()});modal.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close()}if(event.key==='Tab'){const controls=[...modal.querySelectorAll('button,a[href],[tabindex]:not([tabindex="-1"])')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}});
  document.body.append(modal);document.body.classList.add('modalOpen');modal.querySelector('.itineraryClose').focus();
}
window.showItinerary=showItinerary;
function yachtCard(y,opt={}){const mode=opt.mode||'';let modes=[];if(y.private_enabled)modes.push('Private charter');if(y.shared_enabled)modes.push('Liveaboard');const deps=y.matching_departures||[];let sharedNightly=y.shared_rate;if(!sharedNightly&&deps.length)sharedNightly=Math.min(...deps.filter(d=>d.nights&&d.price_pp).map(d=>Number(d.price_pp)/Number(d.nights)));const params=new URLSearchParams({id:y.id});if(mode)params.set('mode',mode);for(const k of ['start','end','guests'])if(opt[k])params.set(k,opt[k]);if(mode==='shared'&&deps[0])params.set('departure_id',deps[0].id);const privatePrice=y.private_rate_public&&y.private_rate?money(y.private_rate)+' / yacht / night':'Tailored quote';const priceRows=`${y.private_enabled?`<div class="cardPriceRow ${mode==='private'?'active':''}"><span>Private</span><strong>${privatePrice}</strong></div>${privateNightRules(y)?`<small class="privateRules">${esc(privateNightRules(y))}</small>`:''}`:''}${y.shared_enabled?`<div class="cardPriceRow ${mode==='shared'?'active':''}"><span>Liveaboard</span><strong>${sharedNightly?money(sharedNightly)+' / person / night':'Request price'}</strong></div>`:''}`;const dep=deps[0];const departure=mode==='shared'&&dep?`<div class="departureSummary"><strong>${esc(dep.title||'Scheduled liveaboard')}</strong><span>${esc(dep.start_date)} → ${esc(dep.end_date)} · ${esc(dep.nights)} nights · ${money(dep.price_pp)} / person</span>${deps.length>1?`<small>+ ${deps.length-1} more matching departure${deps.length===2?'':'s'}</small>`:''}</div>`:'';const action=mode==='private'?(y.private_instant_booking?'Check availability':'Request charter'):'View yacht';return `<a class="card" href="yacht.html?${params}"><div class="imageWrap"><img src="${esc(y.image)}" alt="${esc(y.name)}" width="640" height="420" loading="lazy" decoding="async"><button class="heart" type="button" data-save-yacht="${esc(y.id)}" aria-label="Save ${esc(y.name)}">♡</button></div><div class="cardbody"><div>${modes.map(m=>`<span class="tag">${m}</span>`).join('')}</div><h3>${esc(y.name)}</h3><div class="spec">${esc(y.type)} · ${esc(y.guests)} guests · ${esc(y.cabins)} cabins · ${esc(y.length_m||'—')}m</div>${departure}<div class="cardPrices">${priceRows}</div><div class="cardFoot"><span>${action}</span><span class="rating">★ ${esc(y.rating||'New')} <span class="muted">(${esc(y.reviews||0)})</span></span></div></div></a>`}
async function saveYacht(id,button){try{await api('/api/account/wishlist',{method:'POST',body:JSON.stringify({yacht_id:Number(id)})});if(button.matches('.saveYacht'))button.innerHTML='<span aria-hidden="true">♥</span> Saved';else button.textContent='♥';button.setAttribute('aria-pressed','true')}catch(error){if(error.status===401){const next=location.pathname+location.search+location.hash;location.href=`login.html?next=${encodeURIComponent(next)}&save=${encodeURIComponent(id)}`;return}button.title=error.message}}
document.addEventListener('click',async event=>{const button=event.target.closest?.('[data-save-yacht]');if(!button)return;event.preventDefault();event.stopPropagation();if(button.closest('.accountPage')){try{await api('/api/account/wishlist/'+encodeURIComponent(button.dataset.saveYacht),{method:'DELETE'});button.closest('.card,.catalogueCard,.sharedResult')?.remove()}catch(error){button.title=error.message}return}saveYacht(button.dataset.saveYacht,button)});
document.addEventListener('click',event=>{const button=event.target.closest?.('.saveYacht');if(!button)return;event.preventDefault();event.stopImmediatePropagation();const id=new URLSearchParams(location.search).get('id');if(id)saveYacht(id,button)},true);
function enhanceWishlist(root=document){const cards=[...(root.matches?.('.catalogueCard,.sharedResult')?[root]:[]),...(root.querySelectorAll?.('.catalogueCard,.sharedResult')||[])];cards.forEach(card=>{if(card.querySelector('[data-save-yacht]'))return;const link=card.querySelector('a[href*="yacht.html?"]');if(!link)return;let id;try{id=new URL(link.href).searchParams.get('id')}catch{}if(!id)return;const button=document.createElement('button');button.className='heart catalogueHeart';button.type='button';button.dataset.saveYacht=id;button.setAttribute('aria-label','Save yacht');button.textContent='♡';card.append(button)})}
document.addEventListener('DOMContentLoaded',()=>enhanceWishlist());new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)enhanceWishlist(node)}))).observe(document.documentElement,{subtree:true,childList:true});
document.addEventListener('DOMContentLoaded',()=>{if(location.pathname.endsWith('/admin.html')||location.pathname.endsWith('admin.html')){const auditLink=[...document.querySelectorAll('.side a')].find(link=>link.getAttribute('href')==='#audit');if(auditLink&&!document.querySelector('.side a[href="admin-content.html"]'))auditLink.insertAdjacentHTML('beforebegin','<a href="admin-content.html">Reviews, support & trust</a>')}});

/* Accessible presentation layer for native single-value selects. The select remains
   the form control and source of truth; this component only mirrors it. */
(()=>{
  const enhanced=new WeakMap();let active=null;let uid=0;let typeBuffer='';let typeTimer;
  const eligible=select=>select instanceof HTMLSelectElement&&!select.multiple&&select.size<=1&&!select.matches('[data-native-select],[data-custom-select="false"],.native-select');
  const enabledOptions=select=>Array.from(select.options).filter(option=>!option.disabled&&!(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled));
  const labelFor=select=>select.labels&&select.labels[0]&&select.labels[0].textContent.trim();
  function enhance(select){
    if(!eligible(select)||enhanced.has(select))return;
    const wrap=document.createElement('span');wrap.className='customSelect';
    const trigger=document.createElement('button');trigger.type='button';trigger.className='customSelectTrigger';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    const text=document.createElement('span');text.className='customSelectValue';text.id='custom-select-value-'+(++uid);
    const arrow=document.createElement('span');arrow.className='customSelectArrow';arrow.setAttribute('aria-hidden','true');
    trigger.append(text,arrow);select.insertAdjacentElement('afterend',wrap);wrap.append(trigger);select.classList.add('customSelectNative');
    const state={select,wrap,trigger,text,menu:null,options:[],activeIndex:-1,search:null,status:null};enhanced.set(select,state);
    trigger.addEventListener('click',()=>active===state?close(state,true):open(state));
    trigger.addEventListener('keydown',event=>onTriggerKey(event,state));
    select.addEventListener('focus',()=>trigger.focus());
    select.addEventListener('invalid',()=>{refresh(state);trigger.focus()});
    refresh(state);
  }
  function refresh(state){
    const {select,trigger,text}=state;const selected=select.selectedOptions[0];
    text.textContent=selected?selected.textContent.trim():'Choose an option';
    trigger.disabled=select.disabled;trigger.setAttribute('aria-disabled',String(select.disabled));
    trigger.classList.toggle('is-placeholder',!selected||selected.value==='');
    const label=select.labels&&select.labels[0];if(label){if(!label.id)label.id='custom-select-label-'+(++uid);trigger.setAttribute('aria-labelledby',label.id+' '+text.id);trigger.removeAttribute('aria-label')}else if(select.getAttribute('aria-label'))trigger.setAttribute('aria-label',select.getAttribute('aria-label')+': '+text.textContent);
    if(state.menu)buildMenu(state,state.search?state.search.value:'');
  }
  function createMenu(state){
    const menu=document.createElement('div');menu.className='customSelectMenu';menu.id='custom-select-'+(++uid);menu.hidden=true;
    state.menu=menu;state.trigger.setAttribute('aria-controls',menu.id);
    const list=document.createElement('div');list.className='customSelectList';list.setAttribute('role','listbox');list.tabIndex=-1;list.addEventListener('keydown',event=>onMenuKey(event,state));menu.append(list);
    const status=document.createElement('div');status.className='customSelectStatus srOnly';status.setAttribute('aria-live','polite');menu.append(status);state.status=status;
    document.body.append(menu);return menu;
  }
  function buildMenu(state,query=''){
    const menu=state.menu||createMenu(state);const list=menu.querySelector('.customSelectList');const all=enabledOptions(state.select);const searchable=all.length>=8;
    let search=menu.querySelector('.customSelectSearch');
    if(searchable&&!search){search=document.createElement('input');search.type='search';search.className='customSelectSearch';search.placeholder='Search options';search.setAttribute('aria-label','Search options');search.addEventListener('input',()=>buildMenu(state,search.value));search.addEventListener('keydown',event=>onMenuKey(event,state));menu.prepend(search)}
    if(!searchable&&search){search.remove();search=null}state.search=search;
    const needle=query.trim().toLocaleLowerCase();const visible=all.filter(option=>!needle||option.textContent.toLocaleLowerCase().includes(needle));list.replaceChildren();
    state.options=visible.map(option=>{const item=document.createElement('div');item.className='customSelectOption';item.setAttribute('role','option');item.tabIndex=-1;item.dataset.value=option.value;item.setAttribute('aria-selected',String(option.selected));item.innerHTML='<span class="customSelectCheck" aria-hidden="true">✓</span><span></span>';item.lastChild.textContent=option.textContent.trim();item.addEventListener('pointerdown',event=>event.preventDefault());item.addEventListener('click',()=>choose(state,option));list.append(item);return {option,item}});
    if(!visible.length){const empty=document.createElement('div');empty.className='customSelectEmpty';empty.textContent='No matching options';list.append(empty)}
    state.status.textContent=visible.length+' option'+(visible.length===1?'':'s')+' available';
    const selectedIndex=state.options.findIndex(entry=>entry.option.selected);state.activeIndex=selectedIndex>=0?selectedIndex:(state.options.length?0:-1);setActive(state,state.activeIndex,false);
  }
  function position(state){
    if(!state.menu||state.menu.hidden)return;if(!state.trigger.getClientRects().length){close(state);return}const rect=state.trigger.getBoundingClientRect();const gap=6;const edge=10;const below=innerHeight-rect.bottom-gap;const above=rect.top-gap;const placeAbove=below<260&&above>below;const available=Math.max(140,(placeAbove?above:below)-edge);const width=Math.min(Math.max(rect.width,220),innerWidth-edge*2);
    state.menu.style.width=width+'px';state.menu.style.maxHeight=available+'px';state.menu.style.left=Math.min(Math.max(edge,rect.left),innerWidth-width-edge)+'px';state.menu.style.top=placeAbove?Math.max(edge,rect.top-gap-Math.min(state.menu.scrollHeight,available))+'px':Math.min(innerHeight-edge,rect.bottom+gap)+'px';state.menu.classList.toggle('opensAbove',placeAbove);
  }
  function open(state){
    if(state.select.disabled)return;if(active)close(active);buildMenu(state);state.menu.hidden=false;state.trigger.setAttribute('aria-expanded','true');state.wrap.classList.add('is-open');active=state;position(state);
    if(state.search){state.search.value='';state.search.focus()}else{state.menu.querySelector('.customSelectList').focus();setActive(state,state.activeIndex,true)}
  }
  function close(state,restoreFocus=false){if(!state||!state.menu)return;state.menu.hidden=true;state.trigger.setAttribute('aria-expanded','false');state.trigger.removeAttribute('aria-activedescendant');state.wrap.classList.remove('is-open');if(active===state)active=null;if(restoreFocus)state.trigger.focus()}
  function choose(state,option){state.select.value=option.value;refresh(state);state.select.dispatchEvent(new Event('input',{bubbles:true}));state.select.dispatchEvent(new Event('change',{bubbles:true}));close(state,true)}
  function setActive(state,index,scroll){
    if(!state.options.length){state.activeIndex=-1;state.trigger.removeAttribute('aria-activedescendant');return}
    state.activeIndex=(index+state.options.length)%state.options.length;state.options.forEach((entry,i)=>{entry.item.classList.toggle('is-active',i===state.activeIndex);if(i===state.activeIndex){if(!entry.item.id)entry.item.id=state.menu.id+'-option-'+i;state.trigger.setAttribute('aria-activedescendant',entry.item.id);if(scroll)entry.item.scrollIntoView({block:'nearest'})}});
  }
  function move(state,amount){setActive(state,state.activeIndex+amount,true)}
  function onTriggerKey(event,state){
    if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(event.key)){event.preventDefault();if(active!==state){open(state);if(event.key==='ArrowUp')setActive(state,state.options.length-1,true)}else if(event.key==='ArrowDown')move(state,1);else if(event.key==='ArrowUp')move(state,-1);else if(event.key==='Home')setActive(state,0,true);else if(event.key==='End')setActive(state,state.options.length-1,true);else if((event.key==='Enter'||event.key===' ')&&state.activeIndex>=0)choose(state,state.options[state.activeIndex].option);return}
    if(event.key==='Escape'&&active===state){event.preventDefault();close(state,true);return}if(event.key==='Tab'&&active===state){close(state);return}typeahead(event,state);
  }
  function onMenuKey(event,state){if(event.key==='ArrowDown'){event.preventDefault();move(state,1)}else if(event.key==='ArrowUp'){event.preventDefault();move(state,-1)}else if(event.key==='Home'){event.preventDefault();setActive(state,0,true)}else if(event.key==='End'){event.preventDefault();setActive(state,state.options.length-1,true)}else if((event.key==='Enter'||(event.key===' '&&event.target!==state.search))&&state.activeIndex>=0){event.preventDefault();choose(state,state.options[state.activeIndex].option)}else if(event.key==='Escape'){event.preventDefault();close(state,true)}else if(event.key==='Tab')close(state)}
  function typeahead(event,state){if(event.ctrlKey||event.metaKey||event.altKey||event.key.length!==1)return;typeBuffer+=event.key.toLocaleLowerCase();clearTimeout(typeTimer);typeTimer=setTimeout(()=>typeBuffer='',650);const options=enabledOptions(state.select);const start=Math.max(0,options.indexOf(state.select.selectedOptions[0])+1);const match=options.slice(start).concat(options.slice(0,start)).find(option=>option.textContent.trim().toLocaleLowerCase().startsWith(typeBuffer));if(match){event.preventDefault();state.select.value=match.value;refresh(state);state.select.dispatchEvent(new Event('input',{bubbles:true}));state.select.dispatchEvent(new Event('change',{bubbles:true}))}}
  function syncCustomSelects(target=document){
    if(target instanceof HTMLSelectElement){enhance(target);const state=enhanced.get(target);if(state)refresh(state);return}
    const root=target instanceof Element||target instanceof Document?target:document;root.querySelectorAll('select').forEach(select=>{enhance(select);const state=enhanced.get(select);if(state)refresh(state)});
  }
  window.syncCustomSelects=syncCustomSelects;
  document.addEventListener('pointerdown',event=>{if(active&&!active.wrap.contains(event.target)&&!active.menu.contains(event.target))close(active)});
  document.addEventListener('change',event=>{const state=enhanced.get(event.target);if(state)refresh(state)},true);
  document.addEventListener('reset',event=>setTimeout(()=>syncCustomSelects(event.target)),true);
  addEventListener('resize',()=>{if(active)position(active)});addEventListener('scroll',()=>{if(active)position(active)},true);
  new MutationObserver(records=>{records.forEach(record=>{if(record.target instanceof HTMLSelectElement)syncCustomSelects(record.target);else if(record.target.closest){const select=record.target.closest('select');if(select)syncCustomSelects(select)}record.addedNodes.forEach(node=>{if(node.nodeType===1)syncCustomSelects(node)})});if(active&&!active.trigger.getClientRects().length)close(active)}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','label','selected','value']});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>syncCustomSelects());else syncCustomSelects();
})();

(()=>{
  function associateLabels(){let id=0;document.querySelectorAll('label').forEach(label=>{if(label.htmlFor||label.querySelector('input,select,textarea,button'))return;const control=label.nextElementSibling;if(control&&control.matches('input,select,textarea,button')){if(!control.id)control.id='form-control-'+(++id);label.htmlFor=control.id}})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',associateLabels);else associateLabels();
})();
