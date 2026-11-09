/* Sailo accounts and role portal. Talks to the server API (see apps/server/src/site.ts).
   Sessions are an HttpOnly cookie; this script never sees or stores passwords or tokens. */
(function(){
var $=function(i){return document.getElementById(i)};
var root=document.documentElement;
var esc=function(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')};
var fmt=function(n){return '₱'+Number(n).toLocaleString('en-US')},xl=function(p){return (p/1000).toLocaleString('en-US')+' XLM'};
var post=function(u,d){return window.sailoPost(u,d)};
var getJson=function(u){return fetch(u,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json().catch(function(){return {}}).then(function(b){b.__status=r.status;return b})})};
function icons(){if(window.lucide)lucide.createIcons()}

/* ---------------- auth dialog ---------------- */
var d=$('auth'),f=$('auth-form'),note=$('auth-note'),mode='signup',user=null,cfg={},resetToken=null;
var T={
 signup:['Create your account','Get advances on your next voyage.','Create account','Already have an account? <button type="button" data-mode="signin">Sign in</button>'],
 signin:['Welcome back','Sign in to your Sailo account.','Sign in','New to Sailo? <button type="button" data-mode="signup">Create an account</button>'],
 forgot:['Reset your password','Enter the email you signed up with. We’ll send you a link to choose a new password.','Send reset link','Remembered it? <button type="button" data-mode="signin">Back to sign in</button>'],
 reset:['Choose a new password','You’ll be signed in, and signed out everywhere else.','Save new password','<button type="button" data-mode="signin">Back to sign in</button>']};
function show(el,on){el.hidden=!on}
function setMode(m,keepNote){mode=m;var t=T[m];
  $('auth-title').textContent=t[0];$('auth-sub').textContent=t[1];
  $('auth-submit').textContent=t[2];$('auth-switch').innerHTML=t[3];
  f.querySelectorAll('[data-modes]').forEach(function(el){show(el,el.dataset.modes.split(' ').indexOf(m)>=0)});
  f.name.required=m==='signup';f.email.required=m!=='reset';f.password.required=m!=='forgot';f.confirm.required=m==='reset';
  f.password.autocomplete=m==='signin'?'current-password':'new-password';
  $('pw-label').textContent=m==='reset'?'New password':'Password';
  if(!keepNote)note.innerHTML='';
}
function openAuth(m,msg){
  if(user&&m!=='reset'){enter(user);return}
  setMode(m);if(msg)note.innerHTML=msg;
  if(!d.open){if(d.showModal)d.showModal();else d.setAttribute('open','')}
  setTimeout(function(){(m==='signup'?f.name:m==='reset'?f.password:f.email).focus()},50);
}
function closeAuth(){if(d.open){if(d.close)d.close();else d.removeAttribute('open')}}
window.sailoOpenAuth=openAuth;
document.addEventListener('click',function(e){
  var a=e.target.closest('[data-auth]');if(a){e.preventDefault();openAuth(a.dataset.auth);return}
  var b=e.target.closest('#auth [data-mode]');if(b){var em=f.email.value;setMode(b.dataset.mode);f.email.value=em;return}
  if(e.target.closest('[data-close]')||e.target===d)closeAuth();
});
d.querySelector('.eye').addEventListener('click',function(){
  var s=f.password.type==='password';f.password.type=s?'text':'password';f.confirm.type=f.password.type;
  this.setAttribute('aria-label',s?'Hide password':'Show password');
  this.innerHTML='<i data-lucide="'+(s?'eye-off':'eye')+'" class="i"></i>';icons();
});
/* Development only: the server returns the link it would have emailed when no mail provider is set up. */
function devNote(link,what){return link?'<span class="devlink">Email isn’t set up on this server yet, so here is the '+what+' link (development only): <a href="'+esc(link)+'">open it</a></span>':''}
f.addEventListener('submit',function(e){
  e.preventDefault();if(!f.reportValidity())return;
  var btn=$('auth-submit'),data,url;
  if(mode==='reset'&&f.password.value!==f.confirm.value){note.textContent='The two passwords don’t match.';f.confirm.focus();return}
  if(mode==='signup'){url='/api/auth/signup';data={name:f.name.value.trim(),company:f.company.value.trim(),email:f.email.value.trim(),role:f.role.value,password:f.password.value}}
  else if(mode==='signin'){url='/api/auth/login';data={email:f.email.value.trim(),password:f.password.value}}
  else if(mode==='forgot'){url='/api/auth/forgot';data={email:f.email.value.trim()}}
  else{url='/api/auth/reset';data={token:resetToken,password:f.password.value}}
  btn.disabled=true;note.textContent={signup:'Creating your account…',signin:'Signing in…',forgot:'Sending…',reset:'Saving…'}[mode];
  post(url,data).then(function(r){
    f.password.value='';f.confirm.value='';
    if(mode==='forgot'){note.innerHTML='If an account exists for '+esc(data.email)+', we’ve sent a reset link. It expires in 30 minutes.'+(r.devLink?'<br>'+devNote(r.devLink,'reset'):'');return}
    if(mode==='reset'){resetToken=null;note.textContent='';enter(r.user);toast('Password changed. You’ve been signed out on other devices.');return}
    note.textContent='';lastDevLink=r.devLink||null;enter(r.user);
    if(mode==='signup')toast(cfg.verificationRequired?'Account created. Check '+r.user.email+' for a link to verify your email.':'Account created. Welcome to Sailo.');
  }).catch(function(err){note.textContent=err.message}).then(function(){btn.disabled=false});
});

/* ---------------- toast ---------------- */
var toastT=null;
function toast(msg){var t=$('toast');t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true},6000)}

/* ---------------- email links: ?verify=… and ?reset=… ---------------- */
function takeParam(name){
  var u=new URL(location.href),v=u.searchParams.get(name);
  if(v){u.searchParams.delete(name);history.replaceState(null,'',u.pathname+(u.search||'')+u.hash)}
  return v;
}
var verifyToken=takeParam('verify');resetToken=takeParam('reset');

/* ---------------- verification banner ---------------- */
var lastDevLink=null;
function banner(){
  var b=$('ap-verify');
  if(!user||user.emailVerified||!cfg.verificationRequired){b.hidden=true;return}
  b.hidden=false;
  b.innerHTML='<p><b>Verify your email to fund, tokenize or pay invoices.</b> We sent a link to '+esc(user.email)+'. It expires in 24 hours.</p><button type="button" class="ghost2" id="ap-resend">Resend link</button>'+(lastDevLink?'<p class="small">'+devNote(lastDevLink,'verification')+'</p>':'');
}
document.addEventListener('click',function(e){
  if(!e.target.closest('#ap-resend'))return;
  var btn=e.target.closest('#ap-resend');btn.disabled=true;btn.textContent='Sending…';
  post('/api/auth/verify/resend',{}).then(function(r){lastDevLink=r.devLink||null;banner();toast('We sent a new verification link to '+user.email+'.')})
  .catch(function(x){if(/already verified/i.test(x.message)){user.emailVerified=true;banner()}toast(x.message);btn.disabled=false;btn.textContent='Resend link'});
});

/* ---------------- portal ---------------- */
var ST=['TOKENIZED','FUNDED','ADVANCED','IN_TRANSIT','BERTHED','PAID','SETTLED'];
var LB={TOKENIZED:'Tokenized',FUNDED:'Funded',ADVANCED:'Advanced',IN_TRANSIT:'In transit',BERTHED:'Berthed',PAID:'Paid',SETTLED:'Settled',HOLD:'On hold'};
var PG={'Shipowner':[['inv','Invoices'],['pay','Payouts'],['acct','Account']],'Investor':[['mkt','Marketplace'],['pf','Portfolio'],['acct','Account']],'Cargo owner':[['due','To pay'],['hist','History'],['acct','Account']]};
var HD={inv:['Your invoices','Tokenize an invoice and follow it from advance to settlement.'],pay:['Payouts','Every advance and rebate across your invoices.'],mkt:['Marketplace','Verified freight invoices open for funding.'],pf:['Portfolio','The advances you funded and what comes back.'],due:['Invoices to pay','Pay when the vessel has arrived.'],hist:['History','Invoices you have paid.'],acct:['Your account','Profile, password and the devices you’re signed in on.']};
var role='Shipowner',page='inv',sel=null,inv=[],last='',timer=null,openDet={},busy=false,veloLive=false;

function si(i){return ST.indexOf(i.state==='HOLD'?i.holdFrom:i.state)}
function sum(fn){return inv.reduce(function(a,i){return a+fn(i)},0)}
function err(msg){var e=$('ap-err');e.textContent=msg||'';e.hidden=!msg}

function rows(){var fl={
  pf:function(i){return i.funded},
  mkt:function(i){return !i.funded&&i.state==='TOKENIZED'},
  due:function(i){return si(i)<5},
  hist:function(i){return si(i)>=5}}[page]||function(){return true};
  return inv.filter(fl)}

function stats(){var S={
'Shipowner':['Advanced to you',fmt(sum(function(i){return si(i)>=2?i.m.adv:0})),'Rebate pending',fmt(sum(function(i){return si(i)>=2&&si(i)<6?i.m.reb:0})),'Invoices settled',sum(function(i){return i.state==='SETTLED'?1:0})],
'Investor':['Capital deployed',fmt(sum(function(i){return i.funded&&i.state!=='SETTLED'?i.m.adv:0})),'Returned with yield',fmt(sum(function(i){return i.funded&&i.state==='SETTLED'?i.m.lp:0})),'Open offerings',sum(function(i){return !i.funded&&i.state==='TOKENIZED'?1:0})],
'Cargo owner':['Ready to pay',fmt(sum(function(i){return i.state==='BERTHED'?i.face:0})),'Vessels at sea',sum(function(i){return si(i)>=2&&si(i)<=3?1:0}),'Paid so far',fmt(sum(function(i){return si(i)>=5?i.face:0}))]}[role];
 $('ap-stats').innerHTML=[0,2,4].map(function(k){return '<div class="stat"><small>'+S[k]+'</small><b>'+S[k+1]+'</b></div>'}).join('')}

function bd(i){var c=i.state==='SETTLED'?'ok':i.state==='HOLD'?'hold':'go';return '<span class="bd '+c+'">'+LB[i.state]+'</span>'}

function action(i){var m=i.m,s=i.state;
 if(i.onchain&&s!=='HOLD'&&s!=='SETTLED'){
  if(i.canRetry)return ['A Stellar Testnet step failed three times: '+esc(i.chainError||'unknown error')+'. Transactions that already landed are kept, and a retry continues from there.','retry','Retry on Stellar'];
  if(i.chainBusy)return ['<span class="spin" aria-hidden="true"></span>'+esc(i.chainBusy)+'…'+(i.chainError?' <span class="mute">(retrying after: '+esc(i.chainError)+')</span>':'')];
  if(s==='BERTHED'&&role==='Cargo owner'&&i.checkoutUrl)return ['Your Velo checkout is open. Settlement starts on Stellar as soon as Velo confirms the payment.','checkout','Open Velo checkout'];
  if(s==='BERTHED'&&i.paymentPending)return ['Waiting for Velo to confirm the cargo owner’s payment.']}
 if(s==='HOLD'){var last=i.log[i.log.length-1];
  if(i.agentHold)return ['The agent held this payout for a second look. Nothing moved. '+(last?esc(last.text):''),'retry','Ask the agent again'];
  return ['The agent held this invoice. Nothing moved. '+(last?esc(last.text):'')]}
 if(s==='TOKENIZED'){
  if(role==='Investor')return ['Open for funding. You fund '+fmt(m.adv)+' and receive '+fmt(m.lp)+' at settlement.','fund','Fund '+fmt(m.adv)];
  return [i.simInvestor?'Sample invoice: a simulated investor will fund '+fmt(m.adv)+' in a few seconds.':'Listed in the investor marketplace. Waiting for an investor to fund '+fmt(m.adv)+'.']}
 if(s==='BERTHED'&&role==='Cargo owner')return ['The vessel has arrived. Pay '+fmt(i.face)+' to close this invoice.','pay','Pay '+fmt(i.face)+' securely'];
 if(s==='BERTHED'){var w='The vessel has berthed. Waiting for '+esc(i.debtor)+' to pay';
  return [w+(i.simDebtor?'. Their payment is simulated and arrives in a few seconds.':i.debtorEmail?' from their Sailo portal ('+esc(i.debtorEmail)+').':'.')]}
 return [{FUNDED:'The agent is checking the advance against its limits.',ADVANCED:'Advance paid. The vessel is about to depart.',
  IN_TRANSIT:'At sea. Settlement is released only after the vessel berths and the cargo owner pays.',PAID:'Payment received. The agent is settling.',
  SETTLED:role==='Investor'?'Settled. You received '+fmt(m.lp)+' ('+fmt(m.adv)+' plus '+fmt(m.lp-m.adv)+' yield).':role==='Cargo owner'?'Settled. Thank you for paying through Sailo.':'Settled. Every payee has been paid.'}[s]]}

function detail(i){var m=i.m,a=action(i),k=si(i),who2=role==='Shipowner'?i.debtor:i.owner;
 var rws=[['Advance to shipowner',m.adv,'var(--teal)'],['Repaid to investor',m.lp,'var(--gb)'],['Rebate to shipowner',m.reb,'var(--orange)'],['Protocol fee',m.fee,'var(--mute)']];
 var h='<div class="card"><div class="dh"><div><h2>'+esc(i.vessel)+'</h2><p>'+esc(i.route)+' · '+esc(who2)+' · Net-'+i.term+(i.sample?' · Sample (simulated)':'')+(i.onchain?' · <span class="bd go">Stellar Testnet</span>':'')+'</p></div><div class="fv">'+fmt(i.face)+'<small>'+xl(i.face)+' · '+esc(i.id)+'</small></div></div><ol class="trk">'+ST.map(function(s,x){return '<li class="'+(x<k?'d':x===k?'c':'')+'">'+LB[s]+'</li>'}).join('')+'</ol></div>';
 h+='<div class="card act"><p>'+a[0]+'</p>'+(a[1]?'<button class="btn" data-act="'+a[1]+'" data-id="'+esc(i.id)+'" type="button">'+a[2]+'</button>':'')+'</div>';
 if(k>=2&&k<=4&&i.state!=='HOLD')h+='<div class="card vy"><h3>Voyage</h3><div class="bar"><i style="width:'+i.prog+'%"></i></div><div class="ends"><span>Departed</span><span>'+esc(i.port)+'</span></div></div>';
 h+='<div class="g2"><div class="card"><h3>Where the money goes</h3>'+rws.map(function(r){return '<div class="mrow"><div><span>'+r[0]+'</span><b>'+fmt(r[1])+'</b></div><div class="bar"><i style="width:'+(r[1]/i.face*100).toFixed(1)+'%;background:'+r[2]+'"></i></div></div>'}).join('')+'<div class="esc"><span>Escrow balance now</span><b>'+xl(i.escrow)+'</b></div></div>';
 h+='<div class="card"><h3>Agent limits</h3><div class="pol"><div><span>Largest single payment</span><b>'+xl(m.cap)+'</b></div><div><span>Asset</span><b>XLM</b></div><div><span>Expires</span><b>Net-'+i.term+' + grace</b></div><div><span>Payees</span><b>Fixed by role</b></div></div><p style="margin:0;font-size:13px;color:var(--mute)">The agent cannot pay more than this in one payment. Anything over the limit is refused and nothing moves.</p></div></div>';
 h+='<div class="card" style="margin-top:16px"><h3>Agent activity</h3>'+(i.log.length?i.log.slice().reverse().map(function(e,x){var key=i.id+':'+(i.log.length-x);
  var chip=e.decision?'<span class="bd '+(e.decision==='HOLD'?'hold':'go')+'">'+e.decision+'</span>':'';
  return '<div class="dc"><div class="t">'+chip+(e.decision?'':esc(e.title))+'</div><p>'+esc(e.text)+'</p>'+(e.pay&&e.pay.length?'<div class="pay">'+e.pay.map(function(p){return '<span>'+p[0]+' '+xl(p[1])+'</span>'}).join('')+'</div>':'')+(e.txs&&e.txs.length?'<div class="txl">'+e.txs.map(function(t){return '<a href="'+esc(t.url)+'" target="_blank" rel="noopener">'+esc(t.label)+' · '+esc(t.hash.slice(0,8))+'… ↗</a>'}).join('')+'</div>':'')+'<span class="cn">'+e.c+' · '+(e.onchain?'Stellar Testnet':'simulated')+' · '+new Date(e.at).toLocaleTimeString()+'</span>'+(e.raw?'<details data-k="'+esc(key)+'"'+(openDet[key]?' open':'')+'><summary>Raw decision</summary><pre>'+esc(JSON.stringify(e.raw,null,2))+'</pre></details>':'')+'</div>'}).join(''):'<p style="color:var(--mute)">Nothing yet.</p>')+'</div>';
 return h}

function body(){var b=$('ap-body'),R=rows();
 if(page==='mkt'){
  b.innerHTML=R.length?'<div class="mkt">'+R.map(function(i){var m=i.m;return '<div class="mc"><div><h3>'+esc(i.vessel)+'</h3><p>'+esc(i.route)+' · '+esc(i.owner)+'</p>'+(i.sample?'<span class="who">Sample offering</span>':'')+'</div><dl><div><dt>Invoice value</dt><dd>'+fmt(i.face)+'</dd></div><div><dt>You fund</dt><dd>'+fmt(m.adv)+'</dd></div><div><dt>You receive</dt><dd>'+fmt(m.lp)+'</dd></div><div><dt>Return over '+i.term+' days</dt><dd>'+((m.lp-m.adv)/m.adv*100).toFixed(2)+'%</dd></div></dl><button class="btn" data-act="fund" data-id="'+esc(i.id)+'" type="button">Fund '+fmt(m.adv)+'</button><p>Returns are not guaranteed. If the cargo owner does not pay, investors carry the loss.</p></div>'}).join('')+'</div>':'<div class="empty">No open offerings right now. New invoices appear here when shipowners tokenize them.</div>';return}
 if(page==='pay'){b.innerHTML=R.length?'<div class="tw2"><table><thead><tr><th>Invoice</th><th>Advance</th><th>Rebate</th><th>Status</th></tr></thead><tbody>'+R.map(function(i){var m=i.m,k=si(i);return '<tr><td data-label="Invoice">'+esc(i.vessel)+'<small>'+esc(i.route)+' · '+esc(i.id)+'</small></td><td class="n" data-label="Advance">'+fmt(m.adv)+'<small>'+(k>=2?'Received':'Pending funding')+'</small></td><td class="n" data-label="Rebate">'+fmt(m.reb)+'<small>'+(i.state==='SETTLED'?'Received':'Due at settlement')+'</small></td><td data-label="Status">'+bd(i)+'</td></tr>'}).join('')+'</tbody></table></div>':'<div class="empty">No payouts yet.</div>';return}
 if(!R.length){b.innerHTML='<div class="empty">'+(page==='hist'?'Paid invoices will appear here.':page==='pf'?'Fund an offering in the marketplace to start your portfolio.':page==='due'?'No invoices to pay. Shipowners can bill you by entering '+esc(user&&user.email)+' as the cargo owner email.':'Nothing here yet.')+'</div>';return}
 var cur=R.filter(function(i){return i.id===sel})[0]||R[0];sel=cur.id;
 b.innerHTML='<div class="ap-cols"><aside class="ap-list"><div class="items">'+R.map(function(i){return '<button class="item" type="button" data-id="'+esc(i.id)+'" aria-current="'+(i.id===sel)+'"><div class="row2"><b>'+esc(i.vessel)+'</b>'+bd(i)+'</div><span>'+esc(i.route)+'</span><span>'+fmt(i.face)+' · Net-'+i.term+(i.sample?' · Sample':'')+'</span></button>'}).join('')+'</div></aside><section>'+detail(cur)+'</section></div>'}

function tabs(){$('ap-tabs').innerHTML=PG[role].map(function(p){return '<button type="button" data-p="'+p[0]+'"'+(p[0]===page?' aria-current="page"':'')+'>'+p[1]+'</button>'}).join('')}

function draw(){$('ap-h').textContent=HD[page][0];$('ap-p').textContent=HD[page][1];$('ap-portal').textContent=role+' portal';$('ap-kick').textContent=greet();tabs();
 var acct=page==='acct';$('ap-stats').hidden=acct;if(acct)account();else{stats();body()}
 $('ap-new').hidden=!(role==='Shipowner'&&page==='inv');banner()}

function load(force){
  return getJson('/api/portal').then(function(r){
    if(r.__status===401){exit('Your session ended. Please sign in again.');return}
    if(r.__status!==200){err(r.error||'Could not load your portal.');return}
    err('');
    var key=JSON.stringify(r.invoices);
    inv=r.invoices;veloLive=!!r.velo;
    /* Verification can't be undone, so a response that started before it finished must not undo it. */
    if(r.user){if(user&&user.emailVerified)r.user.emailVerified=true;user=r.user;banner()}
    /* The account page holds forms, so polling never re-renders it. */
    if(force||key!==last){last=key;if(page!=='acct'||force)draw()}
  }).catch(function(){err('Can’t reach Sailo right now. Retrying…')});
}
function poll(){clearTimeout(timer);if(!user)return;timer=setTimeout(function(){(document.hidden?Promise.resolve():load()).then(poll)},1500)}

document.addEventListener('toggle',function(e){var t=e.target;if(t.matches&&t.matches('#ap-body details[data-k]'))openDet[t.dataset.k]=t.open},true);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&user)load()});

document.addEventListener('click',function(e){
 var t=e.target.closest('#ap-tabs [data-p]');if(t){page=t.dataset.p;sel=null;draw();return}
 var it=e.target.closest('#ap-body .item');if(it){sel=it.dataset.id;draw();
   /* On phones the detail sits under the list, so bring it into view. */
   if(matchMedia('(max-width:900px)').matches){var dt=document.querySelector('#ap-body .ap-cols>section');if(dt)dt.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})}
   return}
 var ac=e.target.closest('#ap-body [data-act]');if(!ac||busy)return;
 var id=ac.dataset.id,act=ac.dataset.act;
 if(act==='checkout'){var ci=inv.filter(function(x){return x.id===id})[0];if(ci&&ci.checkoutUrl)window.open(ci.checkoutUrl,'_blank','noopener');return}
 /* Open the window during the click, so the browser doesn't block it; the checkout URL is filled in after. */
 var w=act==='pay'&&veloLive?window.open('about:blank','_blank'):null;
 busy=true;ac.disabled=true;ac.setAttribute('aria-busy','true');
 post('/api/portal/invoices/'+encodeURIComponent(id)+'/'+act,{}).then(function(r){
   if(w){if(r&&r.checkoutUrl){try{w.opener=null}catch(_){}w.location=r.checkoutUrl}else w.close()}
   if(act==='fund'){page='pf';sel=id;scrollTo(0,0)}
   return load(true);
 }).catch(function(x){if(w)w.close();err(x.message);load(true)}).then(function(){busy=false});
});

$('ap-form').addEventListener('submit',function(e){e.preventDefault();var fm=e.target,n=$('ap-fnote'),btn=fm.querySelector('button[type=submit]');if(!fm.reportValidity())return;
 if(!/ to /i.test(fm.route.value)){n.textContent='Write the route like "Manila to Cebu".';return}
 btn.disabled=true;n.textContent='Registering the invoice…';
 post('/api/portal/invoices',{vessel:fm.vessel.value,route:fm.route.value,debtor:fm.debtor.value,debtorEmail:fm.debtorEmail.value,face:Math.round(+fm.face.value),term:+fm.term.value})
 .then(function(r){fm.reset();n.textContent='Tokenized '+r.invoice.id+'. It is now listed for investors.';sel=r.invoice.id;page='inv';return load(true)})
 .catch(function(x){n.textContent=x.message}).then(function(){btn.disabled=false});
});

/* ---------------- account page ---------------- */
function whoLabel(){$('ap-who').textContent=user.company?user.name+' · '+user.company:user.name;
 $('ap-av').textContent=String(user.name||'?').trim().split(/\s+/).slice(0,2).map(function(w){return w[0]}).join('').toUpperCase()}
function greet(){var h=new Date().getHours(),n=user&&user.name?String(user.name).trim().split(/\s+/)[0]:'';
 return (h<12?'Good morning':h<18?'Good afternoon':'Good evening')+(n?', '+n:'')}
function account(){
 var u=user,v=u.emailVerified;
 $('ap-body').innerHTML='<div class="acct">'+
 '<section class="card"><h3>Profile</h3><form id="acct-profile" class="aform" novalidate>'+
  '<label>Full name<input name="name" required maxlength="120" autocomplete="name" value="'+esc(u.name)+'"></label>'+
  '<label><span>Company <span class="opt">(optional)</span></span><input name="company" maxlength="120" autocomplete="organization" value="'+esc(u.company)+'"></label>'+
  '<div class="ro"><span>Email</span><b>'+esc(u.email)+'</b> <span class="bd '+(v?'ok':'hold')+'">'+(v?'Verified':'Not verified')+'</span></div>'+
  '<div class="ro"><span>Account type</span><b>'+esc(u.role)+'</b></div>'+
  (u.wallet?'<div class="ro"><span>Stellar Testnet wallet</span><b><a href="https://stellar.expert/explorer/testnet/account/'+esc(u.wallet)+'" target="_blank" rel="noopener">'+esc(u.wallet.slice(0,6)+'…'+u.wallet.slice(-4))+' ↗</a></b></div>':(u.role!=='Cargo owner'?'<div class="ro"><span>Stellar Testnet wallet</span><b class="mute">Created with your first invoice</b></div>':''))+
  '<button class="btn" type="submit">Save profile</button><p class="fnote" role="status"></p></form></section>'+
 '<section class="card"><h3>Change password</h3><form id="acct-pw" class="aform" novalidate>'+
  '<input type="email" name="username" autocomplete="username" value="'+esc(u.email)+'" hidden>'+
  '<label>Current password<input name="current" type="password" required autocomplete="current-password" maxlength="200"></label>'+
  '<label>New password<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password"><small class="pw-hint">At least 8 characters. Avoid common passwords.</small></label>'+
  '<label>Confirm new password<input name="confirm" type="password" required minlength="8" maxlength="200" autocomplete="new-password"></label>'+
  '<button class="btn" type="submit">Change password</button><p class="fnote" role="status"></p>'+
  '<p class="small mute">Forgot your current password? Sign out and use “Forgot password?” on the sign-in screen.</p></form></section>'+
 '<section class="card"><h3>Signed-in devices</h3><ul class="sess" id="acct-sessions"><li class="mute">Loading…</li></ul>'+
  '<button class="ghost2" type="button" id="acct-others">Sign out of all other devices</button><p class="fnote" id="acct-snote" role="status"></p></section>'+
 '</div>';
 sessions();
}
function ago(iso){var m=Math.round((Date.now()-new Date(iso))/60000);return m<2?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' d ago'}
function sessions(){
 getJson('/api/auth/sessions').then(function(r){var ul=$('acct-sessions');if(!ul)return;
  if(r.__status!==200){ul.innerHTML='<li class="mute">'+esc(r.error||'Could not load sessions.')+'</li>';return}
  ul.innerHTML=r.sessions.map(function(x){return '<li><b>'+esc(x.agent)+'</b>'+(x.current?' <span class="bd ok">This device</span>':'')+'<span class="mute">Signed in '+new Date(x.createdAt).toLocaleDateString()+' · active '+ago(x.lastSeenAt)+'</span></li>'}).join('');
  $('acct-others').hidden=r.sessions.length<2;
 });
}
document.addEventListener('submit',function(e){
 var fm=e.target;if(fm.id!=='acct-profile'&&fm.id!=='acct-pw')return;
 e.preventDefault();if(!fm.reportValidity())return;
 var n=fm.querySelector('.fnote'),btn=fm.querySelector('button[type=submit]');
 if(fm.id==='acct-pw'&&fm.password.value!==fm.confirm.value){n.textContent='The two new passwords don’t match.';return}
 btn.disabled=true;n.textContent='Saving…';
 var req=fm.id==='acct-profile'?post('/api/auth/profile',{name:fm.name.value,company:fm.company.value}).then(function(r){if(user.emailVerified)r.user.emailVerified=true;user=r.user;whoLabel();n.textContent='Profile saved.'})
  :post('/api/auth/password',{current:fm.current.value,password:fm.password.value}).then(function(r){fm.reset();n.textContent='Password changed.'+(r.signedOut?' Signed out of '+r.signedOut+' other device'+(r.signedOut>1?'s':'')+'.':'');sessions()});
 req.catch(function(x){n.textContent=x.message}).then(function(){btn.disabled=false});
});
document.addEventListener('click',function(e){
 if(!e.target.closest('#acct-others'))return;
 var b=$('acct-others');b.disabled=true;
 post('/api/auth/sessions/sign-out-others',{}).then(function(r){$('acct-snote').textContent='Signed out of '+r.signedOut+' other device'+(r.signedOut===1?'':'s')+'.';sessions()})
 .catch(function(x){$('acct-snote').textContent=x.message}).then(function(){b.disabled=false});
});

function enter(u){
 user=u;closeAuth();role=PG[u.role]?u.role:'Shipowner';page=PG[role][0][0];sel=null;last='';inv=[];
 try{sessionStorage.setItem('sailo_in','1')}catch(e){}
 whoLabel();
 if(d.open&&d.close)d.close();root.classList.add('in');scrollTo(0,0);
 $('ap-body').innerHTML='<div class="empty">Loading your portal…</div>';
 load(true).then(poll);
}
function exit(msg){
 user=null;clearTimeout(timer);inv=[];last='';lastDevLink=null;$('ap-verify').hidden=true;
 try{sessionStorage.removeItem('sailo_in')}catch(e){}
 root.classList.remove('in');scrollTo(0,0);
 if(window.ScrollTrigger)setTimeout(function(){ScrollTrigger.refresh()},50);
 if(msg)openAuth('signin',esc(msg));
}
$('ap-out').addEventListener('click',function(){post('/api/auth/logout',{}).catch(function(){}).then(function(){exit()})});

/* Restore a signed-in session on load, then act on any link the user followed from an email. */
getJson('/api/auth/me').then(function(r){
 cfg=r.config||{};
 if(r.user)enter(r.user);else exit();
 if(resetToken)openAuth('reset');
 else if(verifyToken)post('/api/auth/verify',{token:verifyToken}).then(function(v){
   if(user&&v.user){user=v.user;banner();toast('Email verified. You can now fund, tokenize and pay invoices.')}
   else if(user)toast('Email verified for '+v.email+'. Sign in with that account to use it.');
   else{openAuth('signin','Email verified for '+esc(v.email)+'. Sign in to continue.');f.email.value=v.email}
 }).catch(function(x){if(user)toast(x.message);else openAuth('signin',esc(x.message))});
}).catch(function(){exit()});
})();
