/** Shared, versioned host protocol. No credentials or user profile enter this document. */
export const bridgeBootstrap = String.raw`(()=>{
  'use strict';
  let session=null,port=null,seq=0;const pending=new Map();
  function emit(method,payload){
    if(!session)return Promise.reject(new Error('BRIDGE_NOT_READY'));
    const request_id=String(++seq),message={protocol:1,request_id,execution_id:session.execution_id,nonce:session.nonce,method,payload};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(request_id);reject(new Error('BRIDGE_TIMEOUT'));},5000);
      pending.set(request_id,{resolve,reject,timer});
      if(port)port.postMessage(message);
      else if(window.webkit&&window.webkit.messageHandlers.nudgeon)window.webkit.messageHandlers.nudgeon.postMessage(JSON.stringify(message));
      else if(window.NudgeOnNative)window.NudgeOnNative.postMessage(JSON.stringify(message));
      else {clearTimeout(timer);pending.delete(request_id);reject(new Error('NO_HOST'));}
    });
  }
  function receive(result){const p=pending.get(result.request_id);if(!p)return;clearTimeout(p.timer);pending.delete(result.request_id);result.ok?p.resolve(result.result):p.reject(new Error(result.error&&result.error.code||'ACTION_FAILED'));}
  const api=Object.freeze({get timeZone(){return session?.time_zone||'UTC';},ready:()=>emit('ready',{}),performAction:action_id=>emit('performAction',{action_id}),dismiss:reason=>emit('dismiss',{reason:reason||'close_button'}),hideToday:()=>emit('hideToday',{})});
  Object.defineProperty(window,'nudgeonBridge',{value:api,writable:false});
  window.__nudgeonReply=receive;
  window.__nudgeonConnect=function(execution_id,nonce,context){
    if(session)return;session={execution_id,nonce,time_zone:typeof context?.time_zone==='string'?context.time_zone:'UTC'};window.dispatchEvent(new Event('nudgeon:ready'));
    const ready=()=>Promise.all(Array.from(document.images).map(i=>i.decode?i.decode():Promise.resolve())).then(()=>document.fonts?document.fonts.ready:null).then(()=>api.ready()).catch(()=>emit('log',{code:'RESOURCE_ERROR'}).catch(()=>{}));
    document.readyState==='loading'?document.addEventListener('DOMContentLoaded',ready,{once:true}):ready();
  };
  window.addEventListener('message',event=>{
    if(event.source!==parent||session||event.data?.type!=='nudgeon:init'||!event.ports[0])return;
    port=event.ports[0];port.onmessage=e=>receive(e.data);port.start();window.__nudgeonConnect(event.data.execution_id,event.data.nonce);
  });
  window.addEventListener('error',()=>{if(session)emit('log',{code:'JS_ERROR'}).catch(()=>{});});
  window.addEventListener('unhandledrejection',()=>{if(session)emit('log',{code:'JS_REJECTION'}).catch(()=>{});});
  if(parent!==window)parent.postMessage({type:'nudgeon:hello'},'*');
})();`;
