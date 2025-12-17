import {
  InAppBrowser,
  ToolBarType,
  BackgroundColor,
} from "@capgo/inappbrowser";
import type { PluginListenerHandle } from "@capacitor/core";

export interface DAppBrowserOptions {
  url: string;
  title?: string;
  toolbarColor?: string;
  walletAddress?: string;
  chainId?: string;
  rpcUrl?: string;
  onTransactionRequest?: (tx: TransactionRequest) => Promise<string>; // Returns tx hash
  onSignRequest?: (message: string, method: string) => Promise<string>; // Returns signature
}

export interface TransactionRequest {
  from: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
}

let messageListener: PluginListenerHandle | null = null;

// Provider script to inject - simple ES5-compatible version
function getProviderScript(
  address: string,
  chainId: string,
  rpcUrl: string
): string {
  return `(function(){
  try {
    if(window.ethereum&&window.ethereum.isPunkWallet){return;}

    var ADDR='${address}';
    var CHAIN='${chainId}';
    var RPC='${rpcUrl}';
    var pending=new Map();
    var listeners={};
    var rid=0;

    function rpc(m,p){
      return fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rid,method:m,params:p||[]})})
        .then(function(r){return r.json();})
        .then(function(j){if(j.error)throw j.error;return j.result;});
    }

    var currentChain=CHAIN;
    var prov={
      isMetaMask:true,isPunkWallet:true,chainId:CHAIN,networkVersion:String(parseInt(CHAIN,16)),selectedAddress:ADDR,_events:{},
      isConnected:function(){return true;},
      request:function(a){
        var self=this;
        var m=a.method,p=a.params||[];
        if(window.mobileApp&&window.mobileApp.postMessage){
          window.mobileApp.postMessage({detail:{type:'PUNK_WALLET_LOG',method:m}});
        }
        if(m==='eth_requestAccounts'||m==='eth_accounts'){
          return Promise.resolve([ADDR]);
        }
        if(m==='eth_chainId')return Promise.resolve(currentChain);
        if(m==='net_version')return Promise.resolve(String(parseInt(currentChain,16)));
        if(m==='wallet_switchEthereumChain'){
          var newChain=p[0]&&p[0].chainId?p[0].chainId:currentChain;
          if(newChain!==currentChain){
            currentChain=newChain;
            prov.chainId=newChain;
            prov.networkVersion=String(parseInt(newChain,16));
            try{prov.emit('chainChanged',newChain);}catch(x){}
          }
          return Promise.resolve(null);
        }
        if(m==='wallet_addEthereumChain')return Promise.resolve(null);
        if(m==='wallet_requestPermissions'){
          return Promise.resolve([{parentCapability:'eth_accounts',caveats:[{type:'restrictReturnedAccounts',value:[ADDR]}]}]);
        }
        if(m==='wallet_getPermissions'){
          return Promise.resolve([{parentCapability:'eth_accounts',caveats:[{type:'restrictReturnedAccounts',value:[ADDR]}]}]);
        }
        if(m==='eth_sendTransaction'){
          var tid='t'+Date.now();
          return new Promise(function(res,rej){
            pending.set(tid,{r:res,e:rej});
            if(window.mobileApp&&window.mobileApp.postMessage){
              window.mobileApp.postMessage({detail:{type:'PUNK_WALLET_TX',id:tid,method:m,tx:p[0]}});
            }else{pending.delete(tid);rej({code:-32603,message:'No bridge'});}
          });
        }
        if(m==='personal_sign'||m==='eth_sign'){
          var sid='s'+Date.now();
          return new Promise(function(res,rej){
            pending.set(sid,{r:res,e:rej});
            if(window.mobileApp&&window.mobileApp.postMessage){
              window.mobileApp.postMessage({detail:{type:'PUNK_WALLET_SIGN',id:sid,method:m,message:p[0]}});
            }else{pending.delete(sid);rej({code:-32603,message:'No bridge'});}
          });
        }
        if(m==='eth_signTypedData'||m==='eth_signTypedData_v4'){
          var yid='y'+Date.now();
          return new Promise(function(res,rej){
            pending.set(yid,{r:res,e:rej});
            if(window.mobileApp&&window.mobileApp.postMessage){
              window.mobileApp.postMessage({detail:{type:'PUNK_WALLET_SIGN_TYPED',id:yid,method:m,data:p[1]}});
            }else{pending.delete(yid);rej({code:-32603,message:'No bridge'});}
          });
        }
        return rpc(m,p);
      },
      on:function(e,c){if(!listeners[e])listeners[e]=[];listeners[e].push(c);return this;},
      removeListener:function(e,c){if(listeners[e])listeners[e]=listeners[e].filter(function(l){return l!==c;});return this;},
      off:function(e,c){return this.removeListener(e,c);},
      emit:function(e,d){if(listeners[e]){listeners[e].slice().forEach(function(c){try{c(d);}catch(x){}});}},
      enable:function(){return this.request({method:'eth_requestAccounts'});},
      send:function(m,p){return typeof m==='string'?this.request({method:m,params:p}):this.request(m);},
      sendAsync:function(p,c){this.request(p).then(function(r){c(null,{id:p.id,jsonrpc:'2.0',result:r});}).catch(c);}
    };

    window.addEventListener('messageFromNative',function(e){
      var d=e.detail||{};
      console.log('PunkWallet: Response',d.id);
      if(d.id&&pending.has(d.id)){
        var h=pending.get(d.id);pending.delete(d.id);
        if(d.error)h.e(d.error);else h.r(d.result);
      }
    });

    try{delete window.ethereum;}catch(x){}
    try{Object.defineProperty(window,'ethereum',{value:prov,writable:true,configurable:true,enumerable:true});}catch(x){window.ethereum=prov;}

    var info={uuid:'punk-wallet-1',name:'Punk Wallet',icon:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA2ElEQVR4nO2WMQ6DMAxFfwTHYOIMrL0dK/fiwByBI3TpwBE6srpigEowSBQlThM7IZH6pQxJ/J7txHYALMZ/JQHwBNABEDqfJ4BDPQ8A+wDAzHkgAaAB8KznYQCc6rkawMuZPwZwqOeiANDMswnWAF4APgHsyjkRYDq+9IAEwM7M3c5czn4G2HkCaA3gzNyd8xyATT0XAbCp5ywA1vU8GQBf8BSAVT0XAbCs5ywAVvU8GmBmFuec45znKgBbALt6LgLgUs9FAFzqOQsA50oaDMByn9dxgNX4At+jQcgOTR+nAAAAAElFTkSuQmCC',rdns:'app.punkwallet'};
    console.log('PunkWallet: Setting up EIP6963 with provider',typeof prov);
    function ann(){
      try{
        var detail=Object.freeze({info:Object.freeze(info),provider:prov});
        console.log('PunkWallet: Announcing EIP6963, provider.request=',typeof prov.request);
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:detail}));
      }catch(e){console.error('PunkWallet: EIP6963 error',e);}
    }
    window.addEventListener('eip6963:requestProvider',function(){console.log('PunkWallet: EIP6963 requested');ann();});
    ann();setTimeout(ann,100);setTimeout(ann,500);setTimeout(ann,1000);setTimeout(ann,2000);

    setTimeout(function(){prov.emit('connect',{chainId:CHAIN});},10);
    console.log('PunkWallet: Ready',ADDR,CHAIN);
  }catch(err){console.error('PunkWallet ERROR:',err);}
})();`;
}

export const DAppBrowser = {
  async open(options: DAppBrowserOptions): Promise<{ success: boolean }> {
    try {
      // Clean up any existing listener
      if (messageListener) {
        await messageListener.remove();
        messageListener = null;
      }

      // Set up listener for messages from webview (tx requests, sign requests)
      messageListener = await InAppBrowser.addListener(
        "messageFromWebview",
        async (event) => {
          console.log(
            "[DAppBrowser] Raw message event:",
            JSON.stringify(event)
          );

          // The event structure from @capgo/inappbrowser: event.detail contains the message
          // But we also wrapped our data in detail, so it may be event.detail.detail or event.detail
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let data: any = event?.detail;

          // If our data is nested in another detail, unwrap it
          if (data && data.detail && data.detail.type) {
            data = data.detail;
          }

          // Also handle if event itself contains our data (different plugin versions)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (!data?.type && (event as any)?.type) {
            data = event;
          }

          console.log("[DAppBrowser] Parsed data:", JSON.stringify(data));

          if (!data || !data.type) {
            console.log("[DAppBrowser] No valid data type found, ignoring");
            return;
          }

          // Log all RPC method calls from the provider
          if (data.type === "PUNK_WALLET_LOG") {
            console.log(
              "[DAppBrowser] ⚡️ Provider method called:",
              data.method
            );
            return;
          }

          try {
            if (
              data.type === "PUNK_WALLET_TX" &&
              options.onTransactionRequest
            ) {
              console.log("[DAppBrowser] Transaction request:", data.tx);
              const txHash = await options.onTransactionRequest(data.tx);

              // Send result back to webview
              await InAppBrowser.postMessage({
                detail: { id: data.id, result: txHash },
              });
            } else if (
              (data.type === "PUNK_WALLET_SIGN" ||
                data.type === "PUNK_WALLET_SIGN_TYPED") &&
              options.onSignRequest
            ) {
              console.log(
                "[DAppBrowser] Sign request:",
                data.message || data.data
              );
              const signature = await options.onSignRequest(
                data.message || data.data,
                data.method
              );

              await InAppBrowser.postMessage({
                detail: { id: data.id, result: signature },
              });
            }
          } catch (error: unknown) {
            console.error("[DAppBrowser] Handler error:", error);
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";
            const errorCode = (error as { code?: number })?.code || -32603;

            await InAppBrowser.postMessage({
              detail: {
                id: data.id,
                error: { code: errorCode, message: errorMessage },
              },
            });
          }
        }
      );

      // Build provider script if wallet info provided
      let providerScript: string | undefined;
      if (options.walletAddress && options.chainId) {
        const rpcUrl = options.rpcUrl || "https://eth.llamarpc.com";
        providerScript = getProviderScript(
          options.walletAddress,
          options.chainId,
          rpcUrl
        );
        console.log("[DAppBrowser] Provider script ready");
      }

      // Inject provider on page load
      if (providerScript) {
        const pageLoadListener = await InAppBrowser.addListener(
          "browserPageLoaded",
          async () => {
            console.log("[DAppBrowser] Page loaded, injecting provider...");
            try {
              await InAppBrowser.executeScript({ code: providerScript! });
              console.log("[DAppBrowser] Provider injected!");

              // After injection, trigger EIP-6963 re-announcement multiple times
              // This helps dApps that already checked for wallets to discover us
              setTimeout(async () => {
                try {
                  await InAppBrowser.executeScript({
                    code: `if(window.ethereum&&window.ethereum.isPunkWallet){
                      window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{
                        detail:Object.freeze({
                          info:Object.freeze({uuid:'punk-'+Date.now(),name:'Punk Wallet',icon:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA2ElEQVR4nO2WMQ6DMAxFfwTHYOIMrL0dK/fiwByBI3TpwBE6srpigEowSBQlThM7IZH6pQxJ/J7txHYALMZ/JQHwBNABEDqfJ4BDPQ8A+wDAzHkgAaAB8KznYQCc6rkawMuZPwZwqOeiANDMswnWAF4APgHsyjkRYDq+9IAEwM7M3c5czn4G2HkCaA3gzNyd8xyATT0XAbCp5ywA1vU8GQBf8BSAVT0XAbCs5ywAVvU8GmBmFuec45znKgBbALt6LgLgUs9FAFzqOQsA50oaDMByn9dxgNX4At+jQcgOTR+nAAAAAElFTkSuQmCC',rdns:'app.punkwallet'}),
                          provider:window.ethereum
                        })
                      }));
                    }`,
                  });
                } catch (e) {}
              }, 500);
            } catch (e) {
              console.error("[DAppBrowser] Injection failed:", e);
            }
          }
        );

        // Clean up listeners when browser closes
        InAppBrowser.addListener("closeEvent", async () => {
          await pageLoadListener.remove();
          if (messageListener) {
            await messageListener.remove();
            messageListener = null;
          }
        });
      } else {
        // Clean up listeners when browser closes
        InAppBrowser.addListener("closeEvent", async () => {
          if (messageListener) {
            await messageListener.remove();
            messageListener = null;
          }
        });
      }

      await InAppBrowser.openWebView({
        url: options.url,
        title: options.title || "Browser",
        toolbarType: ToolBarType.NAVIGATION,
        backgroundColor: BackgroundColor.BLACK,
        toolbarColor: options.toolbarColor || "#0a0a0a",
        toolbarTextColor: "#ffffff",
        showReloadButton: true,
        activeNativeNavigationForWebview: true,
        preventDeeplink: true,
        isAnimated: true,
      });

      return { success: true };
    } catch (error) {
      console.error("InAppBrowser error:", error);
      throw error;
    }
  },

  async close(): Promise<void> {
    if (messageListener) {
      await messageListener.remove();
      messageListener = null;
    }
    await InAppBrowser.close();
  },

  async executeScript(code: string): Promise<unknown> {
    try {
      // The InAppBrowser executeScript returns the result wrapped
      const result = await InAppBrowser.executeScript({ code });
      console.log("[DAppBrowser] executeScript result:", result);
      // Result might be in different formats depending on plugin version
      return result;
    } catch (error) {
      console.error("[DAppBrowser] executeScript error:", error);
      return null;
    }
  },
};
