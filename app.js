(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput:$('fileInput'),dropZone:$('dropZone'),fileMeta:$('fileMeta'),processBtn:$('processBtn'),status:$('pipelineStatus'),
    canvasWrap:$('canvasWrap'),canvas:$('editorCanvas'),emptyMessage:$('emptyMessage'),brushTool:$('brushTool'),eraserTool:$('eraserTool'),
    brushSize:$('brushSize'),brushSizeText:$('brushSizeText'),undoBtn:$('undoBtn'),resetEditsBtn:$('resetEditsBtn'),fitBtn:$('fitBtn'),
    pdfBtn:$('pdfBtn'),svgBtn:$('svgBtn'),pngBtn:$('pngBtn'),jsonBtn:$('jsonBtn'),toast:$('toast'),
    whiteSwatch:$('whiteSwatch'),whiteCustom:$('whiteCustom'),whiteCustomWrap:$('whiteCustomWrap'),cutSwatch:$('cutSwatch'),
    whitePreview:$('whitePreview'),whiteInfo:$('whiteInfo'),outputName:$('outputName'),
    editWhiteTint:$('editWhiteTint'),editWhiteTintText:$('editWhiteTintText'),editTintLabel:$('editTintLabel'),
    scaffoldWidth:$('scaffoldWidth'),scaffoldMeta:$('scaffoldMeta'),tabWarning:$('tabWarning'),
    metricStatus:$('metricStatus'),metricSize:$('metricSize'),metricComponents:$('metricComponents'),metricHoles:$('metricHoles'),metricWebs:$('metricWebs'),
    modeSingle:$('modeSingle'),modeSheet:$('modeSheet'),singleExportBox:$('singleExportBox'),sheetExportBox:$('sheetExportBox'),expoSummary:$('expoSummary')
  };
  const state={file:null,sourceBitmap:null,artCanvas:null,overlayCanvas:null,w:0,h:0,ppm:0,artMask:null,whitePaths:[],whiteAreaMm2:0,autoMask:null,mask:null,tool:'brush',painting:false,lastPoint:null,history:[],metrics:null,cutLoops:null,cutVectorInfo:null,sourceName:'',cursor:null,dirty:false,customFileName:false,busy:false,loadVersion:0,showArt:true,showWhite:true,showCut:true,flipX:false};
  let batchFiles=[],batchBusy=false;
  // Default white density for single mode and for batch items not yet given
  // their own; once processed, each work-list object carries its whiteTint.
  let tintDefault=100;
  // One editing operation at a time. A tab click can never interleave with
  // the middle of a batch item and leave `state` half-loaded.
  let editorQueue=Promise.resolve();
  // Bumped whenever the file list is replaced. An in-flight run that sees a
  // newer generation stops writing instead of filling the new batch.
  let batchGeneration=0;
  function withEditor(fn){
    const run=editorQueue.then(fn,fn);
    // Keep the queue alive, but never let a failure vanish silently.
    editorQueue=run.catch(()=>{});
    // Reported, not rethrown: these run from event listeners, so throwing would
    // only produce an unhandled rejection nobody can act on.
    return run.catch(err=>{console.error(err);toast('작업 실패: '+(err&&err.message?err.message:err));});
  }
  // Results live in a store that requires an explicit slot on every write,
  // so a tab switch mid-batch can no longer redirect a result.
  const batchStore=new OutlineBatchStore.BatchStore(0);
  const renderState=new OutlineRenderState.RenderState(snapshot=>{if(snapshot)Object.assign(state,snapshot);});
  // Debug handle: lets the test suite observe internal work without scraping the UI.
  window.__outline={state,batchStore,renderState};
  const pdfNestingItems=[];
  // The vendored ClipperLib only auto-publishes to `window` when a DOM exists, so
  // hand the nesting engine the module explicitly. Without this the outline
  // offset silently does nothing and items pack with zero clearance.
  (function injectClipper(){
    const lib=window.ClipperLib||window.__clipperModule;
    if(lib&&window.OutlineNesting&&window.OutlineNesting.exposeClipper)window.OutlineNesting.exposeClipper(lib);
  })();
  // Source pixels are the budget: never upscale, never downscale below what the
  // file carries at the requested physical size. The cap is the press
  // addressability; the area cap keeps one canvas inside browser memory.
  const MAX_DPI=1440, MAX_AREA_PX=160e6, PAD_MM=10, MIN_CORE_MM2=25, WHITE_CHOKE_MM=0.3, WHITE_OPEN_MM=0.15;
  let toastTimer=0;

  // Everything processPipeline() reads, serialised. A saved batch result is only
  // reusable while this string is unchanged, so ANY setting change (mirror,
  // offset, height, tab, gap-fill...) invalidates it automatically.
  const SETTING_IDS=['offsetInput','heightInput','webInput','gapInput','tabWidthInput','tabDepthInput','taperInput','tipRadiusInput','speckInput','alphaInput'];
  function settingsKey(){return JSON.stringify(settings());}
  try{window.__outlineDebug=Object.assign(window.__outlineDebug||{},{settingsKey:()=>settingsKey()});}catch(_){ }
  function settings(){
    const number=(id,fallback)=>{const el=$(id),value=Number(el.value);return el.value!==''&&Number.isFinite(value)?value:fallback;};
    const height=number('heightInput',148.5),tabDepth=number('tabDepthInput',3),offset=number('offsetInput',2);
    return {targetHeight:height,offset,webWidth:number('webInput',10),gap:number('gapInput',4),
      tabWidth:number('tabWidthInput',30),tabDepth,
      taper:number('taperInput',1),tipR:number('tipRadiusInput',.75),speck:number('speckInput',1),alpha:number('alphaInput',8),
      flipX:!!state.flipX};
  }
  function setStatus(text,kind=''){els.status.textContent=text;els.status.className='status-line '+kind;}
  function toast(text){els.toast.textContent=text;els.toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>els.toast.classList.remove('show'),2200);}
  function setEnabled(on){[els.brushTool,els.eraserTool,els.brushSize,els.undoBtn,els.resetEditsBtn,els.fitBtn,els.pdfBtn,els.svgBtn,els.pngBtn,els.jsonBtn,els.editWhiteTint].forEach(x=>x.disabled=!on);}
  function sleep(){return new Promise(r=>setTimeout(r,20));}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

  // Exact Euclidean distance transform (Felzenszwalb-Huttenlocher), separable and linear-time.
  function edt1d(f,n,d,v,z){
    let first=-1;for(let i=0;i<n;i++)if(f[i]<1e19){first=i;break;}
    if(first<0){for(let i=0;i<n;i++)d[i]=1e20;return;}
    let k=0;v[0]=first;z[0]=-Infinity;z[1]=Infinity;
    for(let q=first+1;q<n;q++){
      if(f[q]>=1e19)continue;
      let s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*q-2*v[k]);
      while(s<=z[k]){k--;s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*q-2*v[k]);}
      k++;v[k]=q;z[k]=s;z[k+1]=Infinity;
    }
    k=0;
    for(let q=0;q<n;q++){while(z[k+1]<q)k++;const dx=q-v[k];d[q]=dx*dx+f[v[k]];}
  }
  function distanceField(mask,w,h,featureValue){
    const n=w*h,inf=1e20,tmp=new Float64Array(n),out=new Float64Array(n),max=Math.max(w,h);
    const f=new Float64Array(max),d=new Float64Array(max),v=new Int32Array(max),z=new Float64Array(max+1);
    for(let x=0;x<w;x++){
      for(let y=0;y<h;y++)f[y]=(mask[y*w+x]===featureValue)?0:inf;
      edt1d(f,h,d,v,z);for(let y=0;y<h;y++)tmp[y*w+x]=d[y];
    }
    for(let y=0;y<h;y++){
      const off=y*w;for(let x=0;x<w;x++)f[x]=tmp[off+x];
      edt1d(f,w,d,v,z);for(let x=0;x<w;x++)out[off+x]=d[x];
    }
    return out;
  }
  function dilate(mask,w,h,r){const d=distanceField(mask,w,h,1),r2=r*r,out=new Uint8Array(mask.length);for(let i=0;i<out.length;i++)out[i]=(d[i]<=r2)?1:0;return out;}
  function erode(mask,w,h,r){const d=distanceField(mask,w,h,0),r2=r*r,out=new Uint8Array(mask.length);for(let i=0;i<out.length;i++)out[i]=(mask[i]&&d[i]>r2)?1:0;return out;}
  function closing(mask,w,h,r){return erode(dilate(mask,w,h,r),w,h,r);}

  function components(mask,w,h,minArea=0,collectBoundary=false){
    const n=w*h,labels=new Int32Array(n),queue=new Int32Array(n),result=[];let id=0;
    for(let start=0;start<n;start++){
      if(!mask[start]||labels[start])continue;
      id++;let head=0,tail=0;queue[tail++]=start;labels[start]=id;
      let area=0,minX=w,minY=h,maxX=0,maxY=0,upperHit=false;const boundary=[];
      while(head<tail){
        const p=queue[head++],x=p%w,y=(p-x)/w;area++;if(x<minX)minX=x;if(y<minY)minY=y;if(x>maxX)maxX=x;if(y>maxY)maxY=y;
        let edge=false;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;
          if(xx<0||xx>=w||yy<0||yy>=h){edge=true;continue;}
          const q=yy*w+xx;if(!mask[q]){edge=true;continue;}if(labels[q]===0){labels[q]=id;queue[tail++]=q;}
        }
        if(edge&&collectBoundary)boundary.push(p);
      }
      result.push({id,area,minX,minY,maxX,maxY,upperHit,boundary:collectBoundary?boundary:null});
    }
    return {labels,items:result.filter(c=>c.area>=minArea)};
  }
  function removeSmall(mask,w,h,ppm,minArea){
    const threshold=Math.max(1,Math.round(ppm*ppm*minArea));const cc=components(mask,w,h,0,false);const keep=new Uint8Array(mask.length);let removed=0,kept=0;
    for(const c of cc.items){if(c.area<threshold)removed++;else kept++;}
    for(let i=0;i<mask.length;i++){const id=cc.labels[i];if(id&&cc.items[id-1].area>=threshold)keep[i]=1;}
    return {mask:keep,removed,kept};
  }
  function fillHoles(mask,w,h){
    const n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
    const push=(p)=>{if(!seen[p]&&!mask[p]){seen[p]=1;queue[tail++]=p;}};
    for(let x=0;x<w;x++){push(x);push((h-1)*w+x);}for(let y=0;y<h;y++){push(y*w);push(y*w+w-1);}
    while(head<tail){const p=queue[head++],x=p%w,y=(p-x)/w;if(x>0)push(p-1);if(x+1<w)push(p+1);if(y>0)push(p-w);if(y+1<h)push(p+w);}
    const out=new Uint8Array(mask.length);let holes=0;for(let i=0;i<n;i++){out[i]=mask[i]||!seen[i]?1:0;if(!mask[i]&&!seen[i])holes++;}
    return {mask:out,holes};
  }
  function stats(mask,w,h){let minX=w,minY=h,maxX=-1,maxY=-1,sumX=0,sumY=0,area=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(mask[y*w+x]){area++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;sumX+=x;sumY+=y;}}return {area,minX,minY,maxX,maxY,cx:area?sumX/area:0,cy:area?sumY/area:0,width:maxX-minX+1,height:maxY-minY+1};}
  function segmentInside(mask,w,h,x1,y1,x2,y2){const len=Math.hypot(x2-x1,y2-y1),steps=Math.max(1,Math.ceil(len/3));for(let i=0;i<=steps;i++){const t=i/steps,x=Math.round(x1+(x2-x1)*t),y=Math.round(y1+(y2-y1)*t);if(x<0||x>=w||y<0||y>=h||!mask[y*w+x])return false;}return true;}
  function drawCapsule(mask,w,h,x1,y1,x2,y2,r){const minX=Math.max(0,Math.floor(Math.min(x1,x2)-r)),maxX=Math.min(w-1,Math.ceil(Math.max(x1,x2)+r));const minY=Math.max(0,Math.floor(Math.min(y1,y2)-r)),maxY=Math.min(h-1,Math.ceil(Math.max(y1,y2)+r));const vx=x2-x1,vy=y2-y1,len2=vx*vx+vy*vy,r2=r*r;let add=0;
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){let t=len2?((x-x1)*vx+(y-y1)*vy)/len2:0;t=clamp(t,0,1);const dx=x-(x1+t*vx),dy=y-(y1+t*vy);const p=y*w+x;if(dx*dx+dy*dy<=r2&&!mask[p]){mask[p]=1;add++;}}
    return add;
  }
  function detectNecks(mask,w,h,ppm,webWidth){
    const radius=webWidth*ppm/2,core=erode(mask,w,h,radius),cc=components(core,w,h,MIN_CORE_MM2*ppm*ppm,true),cores=cc.items;
    const added=[];const bucket=radius||1,maxGap=webWidth*ppm,maxGap2=maxGap*maxGap;
    for(let ai=0;ai<cores.length;ai++)for(let bi=ai+1;bi<cores.length;bi++){
      const a=cores[ai],b=cores[bi];const gx=Math.max(0,a.minX-b.maxX,b.minX-a.maxX),gy=Math.max(0,a.minY-b.maxY,b.minY-a.maxY);if(gx*gx+gy*gy>maxGap2)continue;
      const grid=new Map();for(const p of b.boundary){const x=p%w,y=(p-x)/w,bx=Math.floor(x/bucket),by=Math.floor(y/bucket),key=bx+','+by;let arr=grid.get(key);if(!arr){arr=[];grid.set(key,arr);}arr.push(p);}
      let best=maxGap2+1,p1=-1,p2=-1;
      for(const q of a.boundary){const x=q%w,y=(q-x)/w,bx=Math.floor(x/bucket),by=Math.floor(y/bucket);for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const arr=grid.get((bx+ox)+','+(by+oy));if(!arr)continue;for(const p of arr){const xx=p%w,yy=(p-xx)/w,dx=x-xx,dy=y-yy,d=dx*dx+dy*dy;if(d<best){best=d;p1=q;p2=p;}}}}
      if(p1<0||best>maxGap2)continue;const x1=p1%w,y1=(p1-x1)/w,x2=p2%w,y2=(p2-x2)/w;if(!segmentInside(mask,w,h,x1,y1,x2,y2))continue;
      const add=drawCapsule(mask,w,h,x1,y1,x2,y2,radius);if(add)added.push({widthMm:webWidth,gapMm:Math.sqrt(best)/ppm,addedPixels:add,fromPx:[x1,y1],toPx:[x2,y2]});
    }
    return {mask,webs:added,cores:cores.length};
  }
  function roundedRectMask(w,h,cx,top,bottom,widthPx,rPx){const out=new Uint8Array(w*h),half=widthPx/2,left=cx-half,right=cx+half;const x0=Math.max(0,Math.floor(left)),x1=Math.min(w-1,Math.ceil(right));const y0=Math.max(0,Math.floor(top)),y1=Math.min(h-1,Math.ceil(bottom));const r=Math.min(rPx,(right-left)/2,(bottom-top)/2);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const qx=Math.abs(x+.5-cx)-(half-r),qy=Math.abs(y+.5-(top+bottom)/2)-((bottom-top)/2-r);const ox=Math.max(qx,0),oy=Math.max(qy,0);const d=Math.hypot(ox,oy)+Math.min(Math.max(qx,qy),0)-r;if(d<=0)out[y*w+x]=1;}
    return out;
  }
  function addTab(mask,w,h,cx,bottom,ppm,settings){
    const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');const half=settings.tabWidth/2,depth=settings.tabDepth,taper=settings.taper,r=Math.min(settings.tipR,depth/2,half-taper);
    const leftTop=cx-half,rightTop=cx+half,leftBottom=cx-half+taper,rightBottom=cx+half-taper;
    ctx.beginPath();ctx.moveTo(leftTop*ppm,bottom*ppm);ctx.lineTo(rightTop*ppm,bottom*ppm);
    // Symmetric side taper; approach and leave each bottom corner on distinct
    // tangents so both arcTo calls make true, mirrored R arcs.
    ctx.lineTo(rightBottom*ppm,(bottom+depth-r)*ppm);
    ctx.arcTo(rightBottom*ppm,(bottom+depth)*ppm,(rightBottom-r)*ppm,(bottom+depth)*ppm,r*ppm);
    ctx.lineTo((leftBottom+r)*ppm,(bottom+depth)*ppm);
    ctx.arcTo(leftBottom*ppm,(bottom+depth)*ppm,leftBottom*ppm,(bottom+depth-r)*ppm,r*ppm);
    ctx.lineTo(leftTop*ppm,bottom*ppm);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();
    // Concave root fillets where the flanks meet the bar/product bottom line
    // (vector twin: CutVector.tabPoly). Clamped to the room left on the flank.
    const rp=CutVector.tabRootParams(depth,settings.tabWidth,taper,settings.tipR,CutVector.TAB_ROOT_RADIUS_MM);
    if(rp.r>0){const Lf=rp.Lf;for(const sgn of [1,-1]){
      const cornerX=cx+sgn*half,cornerY=bottom;
      const e1x=sgn,e1y=0,e2x=-sgn*taper/Lf,e2y=(depth-r)/Lf;
      const bx=e1x+e2x,by=e1y+e2y,bl=Math.hypot(bx,by),dC=rp.r/Math.sin(rp.phi/2);
      const Cx=(cornerX+bx/bl*dC)*ppm,Cy=(cornerY+by/bl*dC)*ppm;
      const T1x=(cornerX+e1x*rp.t)*ppm,T1y=cornerY*ppm;
      const T2x=(cornerX+e2x*rp.t)*ppm,T2y=(cornerY+e2y*rp.t)*ppm;
      const a1=Math.atan2(T1y-Cy,T1x-Cx),a2=Math.atan2(T2y-Cy,T2x-Cx);
      let span=a2-a1;while(span>Math.PI)span-=2*Math.PI;while(span<-Math.PI)span+=2*Math.PI;
      ctx.beginPath();ctx.moveTo(cornerX*ppm,cornerY*ppm);ctx.lineTo(T1x,T1y);
      ctx.arc(Cx,Cy,rp.r*ppm,a1,a1+span,span<0);ctx.closePath();ctx.fill();
    }}
    const data=ctx.getImageData(0,0,w,h).data,out=mask.slice();for(let i=0;i<out.length;i++)if(data[i*4+3]>0)out[i]=1;return out;
  }
  function findCrossings(mask,w,h,x){const out=[];x=Math.round(x);if(x<1||x>=w-1)return out;for(let y=1;y<h-1;y++){if(mask[y*w+x]!==mask[(y-1)*w+x])out.push([x,y]);}return out;}
  function localJunctionBlend(mask,w,h,ppm,cx,top,bottom,scaffoldWidth){const crossings=[...findCrossings(mask,w,h,cx-scaffoldWidth*ppm/2),...findCrossings(mask,w,h,cx+scaffoldWidth*ppm/2)];if(!crossings.length)return {mask,junctions:0};const smooth=closing(mask,w,h,1.5*ppm),out=mask.slice(),r=5*ppm,r2=r*r;for(const [x,y] of crossings){const x0=Math.max(0,Math.floor(x-r)),x1=Math.min(w-1,Math.ceil(x+r)),y0=Math.max(0,Math.floor(y-r)),y1=Math.min(h-1,Math.ceil(y+r));for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){const dx=xx-x,dy=yy-y;if(dx*dx+dy*dy<=r2)out[yy*w+xx]=smooth[yy*w+xx];}}return {mask:out,junctions:crossings.length};}

  async function processPipeline(){
    if(!state.file)return;const s=settings();const activeHeight=s.targetHeight-2*s.offset-s.tabDepth;
    const invalid=SETTING_IDS.map($).find(el=>el.value===''||!el.checkValidity());
    if(invalid){setStatus('설정값이 허용 범위를 벗어났습니다. 입력값을 확인하세요.','error');invalid.focus();return;}
    if(activeHeight<=10){toast('최종 높이가 외곽 여유·탭보다 너무 작습니다.');return;}
    // A failed re-run must never expose stale geometry paired with a new image.
    state.mask=null;state.autoMask=null;state.whitePaths=[];state.whiteAreaMm2=0;state.metrics=null;state.history=[];state.cutLoops=null;state.cutVectorInfo=null;state.dirty=false;state.busy=true;els.fileInput.disabled=true;
    setEnabled(false);els.processBtn.disabled=true;updateWhiteInfo();resetScaffoldInfo('계산 중…');setStatus('알파 마스크 정리 중…','busy');;await sleep();
    try{
      const crop=state.croppedCanvas;
      const nominalPpm=Math.min(crop.height/activeHeight,MAX_DPI/25.4);
      let targetPx=Math.round(activeHeight*nominalPpm);
      let scaledW=Math.max(1,Math.round(crop.width*targetPx/crop.height));
      if(scaledW*targetPx>MAX_AREA_PX){const f=Math.sqrt(MAX_AREA_PX/(scaledW*targetPx));targetPx=Math.max(1,Math.round(targetPx*f));scaledW=Math.max(1,Math.round(crop.width*targetPx/crop.height));}
      const scaled=document.createElement('canvas');scaled.width=scaledW;scaled.height=targetPx;scaled.getContext('2d').drawImage(crop,0,0,scaledW,targetPx);
      const scaledData=scaled.getContext('2d').getImageData(0,0,scaledW,targetPx).data,scaledMask=new Uint8Array(scaledW*targetPx);let minX=scaledW,minY=targetPx,maxX=-1,maxY=-1;
      for(let y=0;y<targetPx;y++)for(let x=0;x<scaledW;x++)if(scaledData[(y*scaledW+x)*4+3]>s.alpha){scaledMask[y*scaledW+x]=1;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
      if(maxY<minY)throw new Error('알파 임계값보다 높은 전경 픽셀이 없습니다.');
      const activePxH=maxY-minY+1,ppm=activePxH/activeHeight;
      const scaledCleaned=removeSmall(scaledMask,scaledW,targetPx,ppm,s.speck);
      if(!scaledCleaned.kept)throw new Error('작은 조각 제거 후 남은 알파 영역이 없습니다. 제거 기준을 낮춰 주세요.');
      const cleanStats=stats(scaledCleaned.mask,scaledW,targetPx);
      // Leave enough room even when a fixed tab is wider than a narrow body,
      // or when an asymmetric silhouette puts its center near an image edge.
      const possibleOutlineWidth=(maxX-minX+1)/ppm+2*(s.offset+s.webWidth/2)+4/ppm;
      const possibleScaffold=ScaffoldRules.chooseWidth(possibleOutlineWidth).scaffoldWidthMm;
      const safety=s.offset+s.webWidth/2+1;
      const padX=Math.ceil(Math.max(PAD_MM,Math.max(s.tabWidth,possibleScaffold)/2+safety)*ppm);
      // A removed island can make the retained product much shorter than the
      // original crop. Reserve room ABOVE its bottom for the whole triangle.
      const triangleAboveCrop=Math.max(0,25*Math.sqrt(3)-(cleanStats.maxY+1)/ppm);
      const padY=Math.ceil(Math.max(PAD_MM,s.offset+s.webWidth/2+s.tabDepth+1,triangleAboveCrop+safety)*ppm);
      const w=scaledW+padX*2,h=targetPx+padY*2;
      const art=document.createElement('canvas');art.width=w;art.height=h;art.getContext('2d').drawImage(scaled,padX,padY);state.artCanvas=art;state.w=w;state.h=h;state.ppm=ppm;
      const cleaned={mask:new Uint8Array(w*h),removed:scaledCleaned.removed,kept:scaledCleaned.kept};
      for(let y=0;y<targetPx;y++)cleaned.mask.set(scaledCleaned.mask.subarray(y*scaledW,(y+1)*scaledW),(y+padY)*w+padX);
      // Unlike the cut silhouette, the white spot retains transparent holes.
      setStatus('화이트 0.3mm 침식 + 0.15mm 오프닝 벡터화 중…','busy');await sleep();
      state.whitePaths=makeWhitePaths(cleaned.mask,w,h,ppm,WHITE_CHOKE_MM,WHITE_OPEN_MM);
      state.whiteAreaMm2=pathsArea(state.whitePaths)/(ppm*ppm);
      const filled=fillHoles(cleaned.mask,w,h);state.artMask=filled.mask;
      ;setStatus('외곽 오프셋 및 목 연결 감지…','busy');await sleep();
      let outline=dilate(state.artMask,w,h,s.offset*ppm);const beforeWebs=outline.slice();
      const neck=detectNecks(outline,w,h,ppm,s.webWidth);outline=neck.mask;
      ;setStatus('스캐폴드 폭 계산 및 조각 선별 중…','busy');await sleep();
      const baseStats=stats(outline,w,h);if(baseStats.area===0)throw new Error('실루엣 마스크가 비었습니다.');
      // W is the full bounding width AFTER offset and neck reinforcement but
      // BEFORE the scaffold Boolean, gap-fill and tab are applied.
      const scaffold=ScaffoldRules.chooseWidth(baseStats.width/ppm),scaffoldWidth=scaffold.scaffoldWidthMm;
      const scaffoldMask=scaffold.shape==='triangle'
        ?ScaffoldRules.roundedTriangleMask(w,h,baseStats.cx,baseStats.maxY+1,ppm,scaffold.nominalDimensionMm,scaffold.cornerRadiusMm)
        :roundedRectMask(w,h,baseStats.cx,baseStats.minY,baseStats.maxY,scaffoldWidth*ppm,scaffold.cornerRadiusMm*ppm);
      const scaffoldStats=stats(scaffoldMask,w,h);
      const upperEnd=baseStats.minY+(baseStats.height/3);
      const selection=ScaffoldRules.selectFragments(outline,scaffoldMask,w,h,upperEnd);
      const scaffoldUnion=selection.mask;let keptCells=selection.kept;const droppedCells=selection.dropped;
      const gapRadius=(s.gap/2)*ppm;let closed=scaffoldUnion;if(s.gap>0)closed=closing(scaffoldUnion,w,h,gapRadius);
      let gapPixels=0;for(let i=0;i<closed.length;i++)if(closed[i]&&!scaffoldUnion[i])gapPixels++;
      const blend=localJunctionBlend(closed,w,h,ppm,baseStats.cx,baseStats.minY,baseStats.maxY,scaffoldWidth);
      // The contact bar is gone by user decision: the tab hangs directly off the
      // silhouette bottom row. Degenerate artwork (a bottom row that does not
      // cover the tab width) gets the smallest rescue ladder instead of a
      // two-piece cut: raise the tab into the silhouette pixel by pixel, and
      // only as a last resort restore the 1 px bridge row, flagged in metrics.
      // Isolated islands elsewhere in the mask are legal, so the test is "does
      // the tab component reach the silhouette", not "one component total".
      let tabTopPx=baseStats.maxY,barFallback=false;
      let withTab=addTab(blend.mask,w,h,baseStats.cx/ppm,tabTopPx/ppm,ppm,s);
      const tabAttached=(m,topRow)=>{const cxp=Math.min(w-1,Math.max(0,Math.round(baseStats.cx)));const start=Math.min(h-1,topRow+1)*w+cxp;if(!m[start])return false;const seen=new Uint8Array(w*h);const q=[start];seen[start]=1;for(let qi=0;qi<q.length;qi++){const p=q[qi],x=p%w,y=(p-x)/w;if(y<topRow)return true;const nb=[x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1];for(const n2 of nb){if(n2>=0&&m[n2]&&!seen[n2]){seen[n2]=1;q.push(n2);}}}return false;};
      const tabPixels=(m)=>{let n=0;for(let q=0;q<m.length;q++)if(m[q]&&!blend.mask[q])n++;return n;};
      let attached=tabPixels(withTab)===0||tabAttached(withTab,tabTopPx);
      for(let k=1;k<=Math.max(1,Math.round(s.tabDepth*ppm))&&!attached;k++){
        tabTopPx=baseStats.maxY-k;
        withTab=addTab(blend.mask,w,h,baseStats.cx/ppm,tabTopPx/ppm,ppm,s);
        attached=tabPixels(withTab)===0||tabAttached(withTab,tabTopPx);
      }
      if(!attached){
        barFallback=true;tabTopPx=baseStats.maxY;
        const bridge=roundedRectMask(w,h,baseStats.cx,baseStats.maxY,baseStats.maxY+1,scaffoldWidth*ppm,Math.min(0.5,scaffold.cornerRadiusMm)*ppm);
        for(let i2=0;i2<bridge.length;i2++)if(bridge[i2]&&!withTab[i2])withTab[i2]=1;
        withTab=addTab(withTab,w,h,baseStats.cx/ppm,(baseStats.maxY+1)/ppm,ppm,s);
        attached=tabPixels(withTab)===0||tabAttached(withTab,baseStats.maxY+1);
        if(!attached)throw new Error('탭이 본체와 분리되었습니다: 실루엣 밑변이 탭 폭('+s.tabWidth+'mm)을 덮지 않습니다. 탭 폭을 줄이거나 실루엣을 확인하세요.');
      }
      // Plan B cut contour: the silhouette (offset/neck stage, BEFORE scaffold
      // and tab) is simplified with RDP at a physical mm tolerance, and the
      // scaffold and tab are emitted as analytic parametric polygons,
      // so the exported cut no longer carries the 1 px mask staircase. The
      // raster mask above still drives rendering, the white spot and metrics.
      state.cutLoops=null;state.cutVectorInfo=null;
      let outlineLoopsMmDbg=null;
      try{
        const outlineLoopsMm=boundaryLoops(outline,w,h).map(lp=>lp.map(p=>[p[0]/ppm,p[1]/ppm]));
        outlineLoopsMmDbg=outlineLoopsMm;
        state.cutCfg={outlineLoopsMm,cxMm:baseStats.cx/ppm,topMm:baseStats.minY/ppm,bottomMm:(baseStats.maxY+1)/ppm,tabTopMm:tabTopPx/ppm,barRectMm:barFallback?{top:baseStats.maxY/ppm,bottom:(baseStats.maxY+1)/ppm}:null,upperEndMm:upperEnd/ppm,
          scaffold:{shape:scaffold.shape,scaffoldWidthMm:scaffoldWidth,nominalDimensionMm:scaffold.nominalDimensionMm,cornerRadiusMm:scaffold.cornerRadiusMm},
          gapMm:s.gap,speckMm2:s.speck,tab:{width:s.tabWidth,depth:s.tabDepth,taper:s.taper,tipR:s.tipR},
          closingPatches:s.gap>0?rasterPatchLoopsMm(closed,scaffoldUnion,w,h,ppm):[],blendPatches:rasterPatchLoopsMm(blend.mask,closed,w,h,ppm),
          fitTolMm:CutVector.FIT_TOL_MM,fitCornerTurn:CutVector.FIT_CORNER_TURN};const vec=CutVector.buildCutVector(state.cutCfg,ClipperLib);
        if(vec.loops.length){state.cutLoops=vec.loops.map(lp=>lp.map(p=>p[0]==='C'?['C',p[1]*ppm,p[2]*ppm,p[3]*ppm,p[4]*ppm,p[5]*ppm,p[6]*ppm]:[p[0]*ppm,p[1]*ppm]));
          const st=CutVector.loopStats(state.cutLoops);state.cutVectorInfo={points:st.anchors,curves:st.curves,tracePoints:outlineLoopsMm.reduce((a,l)=>a+l.length,0),keptCells:vec.keptCells,droppedCells:vec.droppedCells};state.prefitLoops=vec.prefit||null;}
      }catch(err){console.warn('벡터 칼선 생성 실패 — 래스터 트레이스로 대체합니다:',err);}
      const cleanedFinal=removeSmall(withTab,w,h,ppm,s.speck).mask;const finalFilled=fillHoles(cleanedFinal,w,h);state.mask=finalFilled.mask;state.autoMask=state.mask.slice();state.history=[];
      const webAdded=beforeWebs.reduce((a,v,i)=>a+((!v&&outline[i])?1:0),0)/(ppm*ppm);
      state.metrics={source:state.sourceName,activeArtworkHeightMm:activeHeight,pixelsPerMm:ppm,globalOuterOffsetMm:s.offset,targetOverallCutHeightMm:s.targetHeight,
        actualCutSizeMm:null,componentsRemoved:cleaned.removed,componentsKept:cleaned.kept,initialHolesFilled:filled.holes,whiteChokeMm:WHITE_CHOKE_MM,whiteOpenMm:WHITE_OPEN_MM,whiteAreaMm2:state.whiteAreaMm2,whiteAlphaThreshold:s.alpha,whiteMinIslandAreaMm2:s.speck,whiteHolesPreserved:true,neckCoreCount:neck.cores,
        detectedWebCount:neck.webs.length,detectedWebs:neck.webs.map(x=>({...x,fromPx:x.fromPx.map(v=>v/ppm),toPx:x.toPx.map(v=>v/ppm)})),neckWebAddedAreaMm2:webAdded,
        outlineWidthBeforeScaffoldMm:scaffold.outlineWidthMm,outlineHeightBeforeScaffoldMm:baseStats.height/ppm,scaffoldWidthMm:scaffoldWidth,scaffoldHeightMm:scaffold.triangle?scaffold.triangle.roundedHeightMm:baseStats.height/ppm,scaffoldMaskSizeMm:[scaffoldStats.width/ppm,scaffoldStats.height/ppm],scaffoldNominalDimensionMm:scaffold.nominalDimensionMm,scaffoldCornerRadiusMm:scaffold.cornerRadiusMm,scaffoldTriangle:scaffold.triangle,scaffoldShape:scaffold.shape,scaffoldTier:scaffold.tier,tabWiderThanScaffold:s.tabWidth>scaffoldWidth,tabWiderThanOutline:s.tabWidth>scaffold.outlineWidthMm,deletedUpperThirdCells:droppedCells,retainedCells:keptCells,gapFillThresholdMm:s.gap,gapFillAreaMm2:gapPixels/(ppm*ppm),tabAttachRaiseMm:(baseStats.maxY-tabTopPx)/ppm,tabAttachBarFallback:barFallback,
        junctionBlendCount:blend.junctions,cutVectorized:!!state.cutLoops,cutSimplifyTolMm:typeof CutVector!=='undefined'?CutVector.SIMPLIFY_TOL_MM:null,cutVectorPoints:state.cutVectorInfo?state.cutVectorInfo.points:null,cutVectorCurves:state.cutVectorInfo?state.cutVectorInfo.curves:null,cutFitTolMm:typeof CutVector!=='undefined'?CutVector.FIT_TOL_MM:null,cutTracePointsBefore:state.cutVectorInfo?state.cutVectorInfo.tracePoints:null,tabWidthMm:s.tabWidth,tabDepthMm:s.tabDepth,tabTaperMm:s.taper,tabTipRadiusMm:s.tipR,tabRootRadiusMm:CutVector.tabRootParams(s.tabDepth,s.tabWidth,s.taper,s.tipR,CutVector.TAB_ROOT_RADIUS_MM).r,finalHolesFilled:finalFilled.holes};
      // Debug-only stage snapshot for pipeline reports (?debug=1): raw mask of
      // every conversion step plus the fitted vector loops in pixel coords.
      try{if(location.search.includes('debug=1'))window.__stages={w,h,ppm,trace:outlineLoopsMmDbg,prefit:state.prefitLoops,cutCfg:state.cutCfg,cleaned:cleaned.mask,outline:outline,scaffold:scaffoldMask,sel:selection.mask,closed:closed,blend:blend.mask,withTab:withTab,final:finalFilled.mask,vec:state.cutLoops,info:state.cutVectorInfo};}catch(_){ }
      state.overlayCanvas=document.createElement('canvas');state.overlayCanvas.width=w;state.overlayCanvas.height=h;
      state.dirty=JSON.stringify(s)!==JSON.stringify(settings());
      ;render();refreshMetrics();setEnabled(true);els.undoBtn.disabled=true;els.processBtn.disabled=false;$('workflowStep3').disabled=false;$('workflowStep4').disabled=false;syncTintSlider();updateWhiteInfo();updateScaffoldInfo(scaffold,s.tabWidth,keptCells,droppedCells);
      if(state.dirty){markPipelineDirty();}else if(!state.whitePaths.length){setStatus('화이트 영역이 없습니다. 제거 기준과 침식 후 형상을 확인하세요.','error');}
      else{setStatus('처리 완료 · 브러시/지우개로 직접 수정할 수 있습니다.');}toast('파이프라인 완료');
    }catch(err){console.error(err);resetScaffoldInfo('계산 실패');setStatus('오류: '+(err.message||err),'error');els.processBtn.disabled=false;setEnabled(!!state.mask);}
    finally{state.busy=false;els.fileInput.disabled=false;}
  }

  function maskStats(){if(!state.mask)return null;const s=stats(state.mask,state.w,state.h),cc=components(state.mask,state.w,state.h,0,false);const noHoles=fillHoles(state.mask,state.w,state.h);let holes=0;for(let i=0;i<state.mask.length;i++)if(noHoles.mask[i]&&!state.mask[i])holes++;return {...s,components:cc.items.length,holes};}
  function refreshMetrics(){if(!state.mask)return;const m=maskStats(),ppm=state.ppm,actualH=m.height/ppm,actualW=m.width/ppm;state.metrics.actualCutSizeMm=[actualW,actualH];const noFragments=state.metrics.retainedCells===0;const pass=m.components===1&&m.holes===0&&!state.metrics.tabWiderThanScaffold&&!noFragments;els.metricStatus.textContent=pass?'PASS':'검토 필요';els.metricStatus.style.color=pass?'#15976f':'#d28524';els.metricStatus.title=noFragments?'합칠 스캐폴드 조각이 없습니다.':state.metrics.tabWiderThanScaffold?'탭이 스캐폴드보다 넓습니다. 형상을 확인하세요.':'';els.metricSize.textContent=`${actualW.toFixed(1)} × ${actualH.toFixed(1)} mm`;els.metricComponents.textContent=String(m.components);els.metricHoles.textContent=String(m.holes);els.metricWebs.textContent=String(state.metrics.detectedWebCount||0);}
  let renderQueued=false;
  function scheduleRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render();});}
  function render(){if(!state.mask||!state.artCanvas)return;const canvas=els.canvas,ctx=canvas.getContext('2d');canvas.width=state.w;canvas.height=state.h;ctx.clearRect(0,0,state.w,state.h);if(state.showArt)ctx.drawImage(state.artCanvas,0,0);
    const id=ctx.createImageData(state.w,state.h),d=id.data,w=state.w,h=state.h,m=state.mask;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(!m[i])continue;const p=i*4;const edge=(x===0||x===w-1||y===0||y===h-1||!m[i-1]||!m[i+1]||!m[i-w]||!m[i+w]);if(edge){d[p]=242;d[p+1]=26;d[p+2]=155;d[p+3]=255;}else{d[p]=36;d[p+1]=178;d[p+2]=139;d[p+3]=42;}}
    state.overlayCanvas.getContext('2d').putImageData(id,0,0);if(state.showCut)ctx.drawImage(state.overlayCanvas,0,0);
    if(state.showWhite&&els.whitePreview.checked&&state.whitePaths.length){
      ctx.beginPath();appendCanvasPaths(ctx,state.whitePaths);
      // The tint drives the alpha so 40% white looks like 40% on screen too.
      ctx.fillStyle=`rgba(40,184,222,${(0.06+0.26*(activeTintPercent()/100)).toFixed(3)})`;ctx.fill('evenodd');
      ctx.strokeStyle='rgba(18,161,204,.9)';ctx.lineWidth=Math.max(1,1.5*state.w/Math.max(canvas.clientWidth,1));ctx.stroke();
    }
    if(state.cursor&&state.tool){const r=Number(els.brushSize.value)*state.ppm/2;ctx.beginPath();ctx.arc(state.cursor.x,state.cursor.y,r,0,Math.PI*2);ctx.strokeStyle=state.tool==='brush'?'#0c9c75':'#cc6671';ctx.lineWidth=Math.max(1,2*state.w/canvas.clientWidth);ctx.setLineDash([5,4]);ctx.stroke();ctx.setLineDash([]);}
    els.canvasWrap.classList.add('has-image');els.canvasWrap.classList.remove('empty-state');
  }
  function drawBrushSegment(a,b,mode){const r=Number(els.brushSize.value)*state.ppm/2;drawCapsule(state.mask,state.w,state.h,a.x,a.y,b.x,b.y,r);if(mode==='eraser'){
      // Clear the same capsule region after the additive helper has filled it.
      const minX=Math.max(0,Math.floor(Math.min(a.x,b.x)-r)),maxX=Math.min(state.w-1,Math.ceil(Math.max(a.x,b.x)+r)),minY=Math.max(0,Math.floor(Math.min(a.y,b.y)-r)),maxY=Math.min(state.h-1,Math.ceil(Math.max(a.y,b.y)+r));const vx=b.x-a.x,vy=b.y-a.y,len2=vx*vx+vy*vy,r2=r*r;
      for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){let t=len2?((x-a.x)*vx+(y-a.y)*vy)/len2:0;t=clamp(t,0,1);const dx=x-(a.x+t*vx),dy=y-(a.y+t*vy);if(dx*dx+dy*dy<=r2)state.mask[y*state.w+x]=0;}
    }}
  function eventPoint(e){const r=els.canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*state.w/r.width,y:(e.clientY-r.top)*state.h/r.height};}
  function saveHistory(){state.history.push(state.mask.slice());if(state.history.length>12)state.history.shift();els.undoBtn.disabled=false;}
  function pointerDown(e){if(!state.mask||e.button!==0)return;e.preventDefault();els.canvas.setPointerCapture(e.pointerId);saveHistory();state.painting=true;state.lastPoint=eventPoint(e);drawBrushSegment(state.lastPoint,state.lastPoint,state.tool);render();}
  function pointerMove(e){if(!state.mask)return;const p=eventPoint(e);state.cursor=p;if(state.painting){drawBrushSegment(state.lastPoint,p,state.tool);state.lastPoint=p;scheduleRender();}else scheduleRender();}
  function pointerUp(){if(!state.painting)return;state.painting=false;state.lastPoint=null;render();refreshMetrics();setStatus('수정됨 · 검사 지표를 확인하세요.');}
  function undo(){if(!state.history.length)return;state.mask=state.history.pop();render();refreshMetrics();els.undoBtn.disabled=!state.history.length;toast('한 단계 되돌렸습니다.');}
  function resetEdits(){if(!state.autoMask)return;state.mask=state.autoMask.slice();state.history=[];render();refreshMetrics();els.undoBtn.disabled=true;setStatus('자동 파이프라인 결과로 되돌렸습니다.');}
  function setTool(tool){state.tool=tool;els.brushTool.classList.toggle('active',tool==='brush');els.eraserTool.classList.toggle('active',tool==='eraser');render();}

  function boundaryLoops(mask,w,h){
    const edgeStarts=[],edgeEnds=[],edgeDirs=[],starts=new Map();
    const add=(sx,sy,ex,ey,dir)=>{const a=sy*(w+1)+sx,b=ey*(w+1)+ex,id=edgeStarts.length;edgeStarts.push(a);edgeEnds.push(b);edgeDirs.push(dir);let ar=starts.get(a);if(!ar){ar=[];starts.set(a,ar);}ar.push(id);};
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=y*w+x;if(!mask[p])continue;
      if(y===0||!mask[p-w])add(x,y,x+1,y,0);
      if(x===w-1||!mask[p+1])add(x+1,y,x+1,y+1,1);
      if(y===h-1||!mask[p+w])add(x+1,y+1,x,y+1,2);
      if(x===0||!mask[p-1])add(x,y+1,x,y,3);
    }
    const used=new Uint8Array(edgeStarts.length),loops=[];const priority=[1,0,3,2];
    for(let start=0;start<edgeStarts.length;start++){if(used[start])continue;let id=start,ring=[],guard=0;const startV=edgeStarts[start];
      while(!used[id]&&guard++<edgeStarts.length+10){used[id]=1;const v=edgeStarts[id];ring.push([v%(w+1),Math.floor(v/(w+1))]);const end=edgeEnds[id];if(end===startV)break;const opts=starts.get(end)||[];let next=-1;for(const want of priority){next=opts.find(q=>!used[q]&&edgeDirs[q]===((edgeDirs[id]+want)%4));if(next!==undefined)break;next=-1;}if(next<0)break;id=next;}
      if(ring.length>=4){const simplified=[];for(let i=0;i<ring.length;i++){const prev=ring[(i+ring.length-1)%ring.length],cur=ring[i],nxt=ring[(i+1)%ring.length];const dx1=Math.sign(cur[0]-prev[0]),dy1=Math.sign(cur[1]-prev[1]),dx2=Math.sign(nxt[0]-cur[0]),dy2=Math.sign(nxt[1]-cur[1]);if(dx1!==dx2||dy1!==dy2)simplified.push(cur);}if(simplified.length>=3)loops.push(simplified);}
    }
    return loops;
  }
  // Offset the cleaned alpha geometry in sub-pixel vector coordinates. This
  // gives a true 0.3 mm erosion rather than rounding the choke to whole pixels,
  // and the follow-up 0.15 mm opening (shrink then regrow) deletes hairline
  // spikes from the plate. All rings offset together, so holes grow correctly.
  function makeWhitePaths(mask,w,h,ppm,chokeMm,openMm=0){
    if(typeof ClipperLib==='undefined')throw new Error('벡터 오프셋 라이브러리를 불러오지 못했습니다.');
    const loops=boundaryLoops(mask,w,h),scale=1000;if(!loops.length)return [];
    const subject=loops.map(r=>r.map(([x,y])=>({X:Math.round(x*scale),Y:Math.round(y*scale)})));
    const run=(paths,delta)=>{
      const offset=new ClipperLib.ClipperOffset(2,25),out=new ClipperLib.Paths();
      offset.AddPaths(paths,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
      offset.Execute(out,delta);
      return out.filter(r=>r.length>=3);
    };
    // Erode the silhouette under the cut edge first...
    let result=run(subject,-chokeMm*ppm*scale);
    // ...then open it: shrink and regrow by the opening radius so thin spikes and
    // hairline fingers narrower than twice the radius drop out of the plate,
    // while the bulk of the shape returns to the eroded outline.
    if(openMm>0&&result.length){
      const shrunk=run(result,-openMm*ppm*scale);
      if(shrunk.length)result=run(shrunk,+openMm*ppm*scale);
    }
    return result.map(r=>r.map(p=>[p.X/scale,p.Y/scale]));
  }
  function pathsArea(paths){let area=0;for(const ring of paths){for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];area+=(a[0]*b[1]-b[0]*a[1])/2;}}return Math.abs(area);}
  function appendCanvasPaths(ctx,paths){for(const r of paths){if(!r.length)continue;ctx.moveTo(r[0][0],r[0][1]);for(let i=1;i<r.length;i++){const p=r[i];if(p[0]==='C')ctx.bezierCurveTo(p[1],p[2],p[3],p[4],p[5],p[6]);else ctx.lineTo(p[0],p[1]);}ctx.closePath();}}
  function pathsToSvg(paths){const n=x=>String(Math.round(x*1000)/1000);return paths.filter(r=>r.length>=3).map(r=>`M ${n(r[0][0])} ${n(r[0][1])} `+r.slice(1).map(p=>p[0]==='C'?`C ${n(p[1])} ${n(p[2])} ${n(p[3])} ${n(p[4])} ${n(p[5])} ${n(p[6])}`:`L ${n(p[0])} ${n(p[1])}`).join(' ')+' Z').join(' ');}
  function updateWhiteInfo(){
    if(!els.whiteInfo)return;
    if(!state.mask){els.whiteInfo.textContent='';return;}
    els.whiteInfo.textContent=state.whitePaths.length?`화이트 면적 ${state.whiteAreaMm2.toFixed(2)} mm² · 작은 섬 ${state.metrics.componentsRemoved}개 제거.`:'화이트 영역이 없습니다. 작은 조각 제거 기준과 입력 이미지를 확인하세요.';
  }
  function resetScaffoldInfo(label='처리 후 계산'){
    els.scaffoldWidth.textContent=label;els.scaffoldMeta.textContent='오프셋·보강 후 아웃라인 폭에 따라 결정';
    els.tabWarning.textContent='';els.tabWarning.classList.add('hidden');
  }
  function updateScaffoldInfo(scaffold,tabWidth,keptCells,droppedCells){
    const f=n=>Number(n.toFixed(2)).toString(),triangle=scaffold.shape==='triangle';
    els.scaffoldWidth.textContent=triangle?'기준 변 50 mm':'폭 50 mm';
    els.scaffoldMeta.textContent=`아웃라인 ${f(scaffold.outlineWidthMm)} mm · ${triangle?'둥근 정삼각형':'둥근 사각형'} · R1`;
    const warnings=[];
    if(triangle)warnings.push(`삼각형은 둥글리기 전 한 변 50mm, R1 적용 후 최대 폭 약 ${f(scaffold.scaffoldWidthMm)}mm입니다.`);
    if(triangle&&scaffold.scaffoldWidthMm>scaffold.outlineWidthMm)warnings.push('스캐폴드가 본품보다 넓습니다.');
    const shapeName=triangle?'삼각형':'사각형';
    if(keptCells===0&&droppedCells>0)warnings.push(`상단 1/3 규칙에 따라 ${shapeName} 조각이 남지 않아 스캐폴드가 추가되지 않았습니다.`);
    else if(keptCells===0)warnings.push(`${shapeName}이 본품 안에 포함되어 별도로 합칠 바깥 조각이 없습니다.`);
    else if(droppedCells>0)warnings.push(`상단 1/3에 닿는 조각 ${droppedCells}개를 제외하고 ${keptCells}개를 합쳤습니다.`);
    if(tabWidth>scaffold.scaffoldWidthMm){
      const extra=tabWidth>scaffold.outlineWidthMm?' 본품 아웃라인보다도 넓습니다.':'';
      warnings.push(`탭 폭 ${f(tabWidth)}mm가 스캐폴드 외형 폭 ${f(scaffold.scaffoldWidthMm)}mm보다 넓습니다.${extra} 탭 폭은 변경하지 않았습니다.`);
    }
    if(warnings.length){els.tabWarning.textContent=warnings.join(' ');els.tabWarning.classList.remove('hidden');}
    else{els.tabWarning.textContent='';els.tabWarning.classList.add('hidden');}
  }
  function markPipelineDirty(){
    if(!state.mask)return;state.dirty=true;resetScaffoldInfo('다시 실행 필요');[els.pdfBtn,els.svgBtn,els.pngBtn,els.jsonBtn].forEach(x=>x.disabled=true);
    setStatus('파이프라인 설정이 변경되었습니다. 다시 실행한 뒤 내보내세요.','error');
  }
  function rawSpotNames(){
    return {white:(els.whiteSwatch.value==='custom'?els.whiteCustom.value:els.whiteSwatch.value).trim(),cut:els.cutSwatch.value.trim()};
  }
  function spotNames(){
    const {white,cut}=rawSpotNames();
    const reserved=new Set(['all','none','cyan','magenta','yellow','black']);
    for(const [label,name] of [['화이트',white],['칼선',cut]]){
      if(!name)throw new Error(label+' 스와치 이름을 입력해 주세요.');
      if(!/^[\x20-\x7e]+$/.test(name)||new TextEncoder().encode(name).length>127)throw new Error(label+' 스와치 이름은 영문·숫자·일반 기호로 127자 이내로 입력해 주세요.');
      if(reserved.has(name.toLowerCase()))throw new Error(label+' 스와치 이름은 PDF 예약 색상명(All, None, Cyan, Magenta, Yellow, Black)을 사용할 수 없습니다.');
    }
    if(white===cut)throw new Error('화이트와 칼선에는 서로 다른 스와치 이름을 사용해 주세요.');
    return {white,cut};
  }
  // White ink tint. 100% is a full opaque plate; lower values lay down a
  // translucent white, which the /Separation component carries directly.
  // The work list (batchStore records) owns one white density per item: the
  // record's whiteTint field. The edit-toolbar slider edits the active item's
  // value; items without a record yet (and single mode) use tintDefault.
  function activeRecord(){
    return batchFiles.length>1&&batchStore.active>=0?batchStore.ref(batchStore.active):null;
  }
  function activeTintPercent(){
    const r=activeRecord();
    return r&&Number.isFinite(r.whiteTint)?Math.max(0,Math.min(100,r.whiteTint)):tintDefault;
  }
  function syncTintSlider(){
    if(els.editWhiteTint)els.editWhiteTint.value=String(activeTintPercent());
    updateWhiteTintLabel();
    updateTintScope();
  }
  // The slider lives in the edit UI and always edits exactly one work object:
  // the active batch record, or the single-job default when there is no list.
  function updateTintScope(){
    if(!els.editTintLabel)return;
    const many=batchFiles.length>1;
    els.editTintLabel.textContent=many&&batchStore.active>=0
      ?`화이트 농도 · 항목 ${batchStore.active+1}/${batchFiles.length}`:'화이트 농도';
  }
  function updateWhiteTintLabel(){
    const v=activeTintPercent();
    if(els.editWhiteTintText)els.editWhiteTintText.textContent=v.toFixed(0)+'%';
    if(els.editWhiteTint)els.editWhiteTint.setAttribute('aria-valuetext',v.toFixed(0)+' 퍼센트');
  }
  function filenameStem(value){
    const name=String(value||'').trim().replace(/\.(?:pdf|svg|png|json)$/i,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim();
    return Array.from(name||'outline-studio').slice(0,120).join('');
  }
  function download(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1200);}
  // Keep the padded editing workspace intact, but trim saved artwork to the
  // final cutline bounds (plus one raster pixel so the 0.2mm stroke is not clipped).
  function exportCrop(){return cropBoxFor(state.mask,state.w,state.h);}
  function cropCanvas(source,b){const c=document.createElement('canvas');c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(source,b.left,b.top,b.width,b.height,0,0,b.width,b.height);return c;}
  function shiftPaths(paths,b){return CutVector.shiftLoops(paths,-b.left,-b.top);}
  // Vector cut contour when the mask is untouched by the brush; painting always
  // falls back to tracing the edited mask so edits export exactly as drawn.
  function cutLoopsOrTrace(mask,w,h){if(state.cutLoops&&state.history.length===0&&mask===state.mask&&w===state.w&&h===state.h&&!location.search.includes('vec=0'))return state.cutLoops;return boundaryLoops(mask,w,h);}
  // Vectorize only the pixels a raster morphology ADDED (closing gap fills and
  // junction-blend slivers) so the vector chain matches the shipped mask
  // behaviour exactly, including its pixel-centred fill threshold.
  function rasterPatchLoopsMm(big,small,w,h,ppm){const diff=new Uint8Array(w*h);for(let i=0;i<diff.length;i++)diff[i]=big[i]&&!small[i]?1:0;
    return boundaryLoops(diff,w,h).map(lp=>CutVector.simplifyLoop(lp.map(p=>[p[0]/ppm,p[1]/ppm]),CutVector.SIMPLIFY_TOL_MM));}
  function exportSvg(){
    if(!state.mask||state.dirty)return;setStatus('SVG 벡터 경로 생성 중…','busy');setTimeout(()=>{try{
      const names=spotNames(),box=exportCrop(),cut=pathsToSvg(shiftPaths(cutLoopsOrTrace(state.mask,state.w,state.h),box)),white=pathsToSvg(shiftPaths(state.whitePaths,box));
      const width=box.width/state.ppm,height=box.height/state.ppm,art=cropCanvas(state.artCanvas,box),artUrl=art.toDataURL('image/png');
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(4)}mm" height="${height.toFixed(4)}mm" viewBox="0 0 ${box.width} ${box.height}"><metadata>SVG spot names are labels only. Use the PDF for real Separation color spaces. Illustrator: open SVG then Object &gt; Release to Layers (Build) to split Artwork/White/Cutline groups into layers. PDF OCG layers show in Acrobat, not as Illustrator layers.</metadata><g id="Artwork"><image x="0" y="0" width="${box.width}" height="${box.height}" href="${artUrl}"/></g><g id="White" data-spot-name="${escapeHtml(names.white)}"><path d="${white}" fill="#ffffff" fill-rule="evenodd"/></g><g id="Cutline" data-spot-name="${escapeHtml(names.cut)}"><path d="${cut}" fill="none" stroke="#f21a9b" stroke-width="${(0.2*state.ppm).toFixed(3)}" stroke-linejoin="round" stroke-linecap="round"/></g></svg>`;
      download(filenameStem(els.outputName.value)+'.svg',new Blob([svg],{type:'image/svg+xml'}));setStatus('SVG 다운로드 완료 · Illustrator에서 Release to Layers로 3레이어 분리하세요.');
    }catch(e){console.error(e);setStatus('SVG 생성 실패: '+e.message,'error');toast(e.message);}},30);
  }
  async function exportPdf(){
    if(!state.mask||state.dirty)return;
    try{
      const names=spotNames(),fileName=filenameStem(els.outputName.value)+'.pdf';if(!state.whitePaths.length)throw new Error('화이트 영역이 없습니다. 작은 조각 제거 기준을 확인해 주세요.');
      const box=exportCrop(),cutPaths=shiftPaths(cutLoopsOrTrace(state.mask,state.w,state.h),box),whitePaths=shiftPaths(state.whitePaths,box);if(!cutPaths.length)throw new Error('칼선이 비어 있습니다.');
      const artwork=cropCanvas(state.artCanvas,box);
      setStatus('화이트·칼선 스팟 PDF 생성 중…','busy');els.pdfBtn.disabled=true;await sleep();
      const blob=await OutlinePDF.create({artwork,width:box.width,height:box.height,pixelsPerMm:state.ppm,whitePaths,cutPaths,whiteName:names.white,cutName:names.cut,whiteTint:activeTintPercent()});
      download(fileName,blob);setStatus('PDF 다운로드 완료 · RIP에서 스팟과 인쇄 순서를 확인하세요.');
    }catch(e){console.error(e);setStatus('PDF 생성 실패: '+e.message,'error');toast(e.message);}
    finally{els.pdfBtn.disabled=!state.mask||state.dirty;}
  }
  function exportPng(){if(!state.mask||state.dirty)return;const box=exportCrop(),c=document.createElement('canvas');c.width=box.width;c.height=box.height;const ctx=c.getContext('2d');ctx.beginPath();appendCanvasPaths(ctx,shiftPaths(state.whitePaths,box));ctx.fillStyle='#fff';ctx.fill('evenodd');ctx.drawImage(state.artCanvas,box.left,box.top,box.width,box.height,0,0,box.width,box.height);const loops=shiftPaths(cutLoopsOrTrace(state.mask,state.w,state.h),box);ctx.beginPath();appendCanvasPaths(ctx,loops);ctx.strokeStyle='#f21a9b';ctx.lineWidth=Math.max(2,.2*state.ppm);ctx.lineJoin='round';ctx.stroke();c.toBlob(b=>{if(b)download(filenameStem(els.outputName.value)+'.png',b);else toast('PNG 생성에 실패했습니다.');},'image/png');}
  function exportJson(){if(!state.mask||state.dirty)return;const current=maskStats();const {white,cut}=rawSpotNames();const report={...state.metrics,source:state.sourceName,actualCutSizeMm:[current.width/state.ppm,current.height/state.ppm],connectedComponents:current.components,internalHoles:current.holes,manualEdits:state.history.length>0,whiteSpotName:white,cutSpotName:cut,clientOnly:true};download(filenameStem(els.outputName.value)+'.json',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));}
  function cropBoxFor(mask,w,h){let minX=w,minY=h,maxX=-1,maxY=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x]){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}if(maxX<minX)throw new Error('칼선 경계가 비어 있습니다.');const left=Math.max(0,minX-1),top=Math.max(0,minY-1),right=Math.min(w,maxX+2),bottom=Math.min(h,maxY+2);return {left,top,width:right-left,height:bottom-top};}
  async function canvasFromBlob(blob,w,h){const bmp=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(bmp,0,0);bmp.close();return c;}
  // Re-derive the white plate from the painted alpha matte and intersect it with
  // the plate imported from the source, so the white can never overhang the
  // visible artwork. Opaque pages (no matte) keep the imported plate as-is.
  function refineWhiteToAlpha(item){
    const canvas=item.artwork;
    if(!canvas||!item.whitePaths||!item.whitePaths.length)return null;
    const w=canvas.width,h=canvas.height;
    const data=canvas.getContext('2d').getImageData(0,0,w,h).data;
    let ones=0;const mask=new Uint8Array(w*h);
    for(let i=0,p=3;i<mask.length;i++,p+=4)if(data[p]>8){mask[i]=1;ones++;}
    if(ones>=w*h*0.985)return null;
    const matteWhite=makeWhitePaths(mask,w,h,item.pixelsPerMm,WHITE_CHOKE_MM,WHITE_OPEN_MM);
    if(!matteWhite.length)return null;
    const both=window.OutlinePdfImport.chokeWhitePaths(matteWhite,item.pixelsPerMm,item.whitePaths,0,0);
    return both.length?both:null;
  }
  // PDFs imported through "완성된 PDF 추가" skip the PNG pipeline entirely:
  // they already carry artwork + white + cut paths.
  async function importFinishedPdfs(files){
    if(!files||!files.length)return;
    for(const file of files){
      if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast(`${file.name}: PDF가 아닙니다.`);continue;}
      setStatus(`${file.name} 읽는 중…`,'busy');
      try{
        const buffer=await file.arrayBuffer();
        const item=await window.OutlinePdfImport.toNestingItem(buffer,{name:filenameStem(file.name),pixelsPerMm:'native'});
        // Drop the full-res canvas as soon as the compressed plates exist: a
        // 1440 dpi piece owns ~180 MB of canvas and a sheet job stacks one per
        // design. The thumbnail keeps the preview and the manual editor fed.
        setStatus(`${file.name} 플레이트 인코딩 중…`,'busy');
        // The visible image is the painted matte, and source plates can sit a
        // touch proud of it; keep the white inside what actually prints.
        const refined=refineWhiteToAlpha(item);
        if(refined)item.whitePaths=refined;
        item.pixels=await OutlinePDF.encodeArtwork(item.artwork,item.width,item.height);
        item.thumb=thumbnailDataUrl(item.artwork,320);
        item.artwork=null;
        pdfNestingItems.push({...item,fileName:file.name,importedAt:Date.now()});
        setStatus(`${file.name} 추가됨 · ${item.widthMm.toFixed(1)} × ${item.heightMm.toFixed(1)} mm · ${Math.round(item.pixelsPerMm*25.4)} dpi`);
      }catch(e){
        console.error(e);
        pdfNestingItems.push({name:filenameStem(file.name),error:e.message,fileName:file.name});
        setStatus(`${file.name} 실패: ${e.message}`,'error');
      }
    }
    renderPdfImportList();
  }
  function renderPdfImportList(){
    const list=$('pdfImportList'),count=$('pdfImportCount');
    if(!list)return;
    const ok=pdfNestingItems.filter(i=>!i.error),bad=pdfNestingItems.filter(i=>i.error);
    if(count)count.textContent=`${ok.length}개${bad.length?` · 실패 ${bad.length}`:''}`;
    list.innerHTML=pdfNestingItems.map((it)=>it.error
      ?`<li class="err"><b>${escapeHtml(it.fileName||it.name)}</b><span>${escapeHtml(it.error)}</span></li>`
      :`<li><b>${escapeHtml(it.name)}</b><span>${it.widthMm.toFixed(1)} × ${it.heightMm.toFixed(1)} mm</span></li>`).join('');
  }
  // ---------------------------------------------------------------- sheet items
  // A nesting job collects every printable piece: imported finished PDFs and
  // the stored batch results (or the single live result when there is no list).
  async function collectNestingItems(){
    const items=[];
    for(const pdf of pdfNestingItems){
      if(pdf.error||!(pdf.artwork||pdf.pixels))continue;
      items.push(pdf);
    }
    if(batchFiles.length>1){
      if(batchStore.active>=0&&state.mask)await saveBatchInto(batchStore.active);
      for(let i=0;i<batchFiles.length;i++){
        const r=batchStore.get(i);if(!r||!r.maskRle)continue;
        const mask=unpackMask(r.maskRle,r.pixels),box=cropBoxFor(mask,r.w,r.h);
        const full=await canvasFromBlob(r.artBlob,r.w,r.h);
        const artwork=cropCanvas(full,box);
        const cutPaths=shiftPaths(r.cutLoops&&!(r.history&&r.history.length)?r.cutLoops:boundaryLoops(mask,r.w,r.h),box),whitePaths=shiftPaths(r.whitePaths,box);
        if(!cutPaths.length||!whitePaths.length)continue;
        // Compress once, then release the canvas: batch rows otherwise keep one
        // full-res canvas per design alive for the whole session.
        const thumb=thumbnailDataUrl(artwork,320);
        const pixels=await OutlinePDF.encodeArtwork(artwork,box.width,box.height);
        items.push({name:r.outputName||filenameStem(r.name||`item-${i+1}`),artwork:null,pixels,thumb,width:box.width,height:box.height,pixelsPerMm:r.ppm,whitePaths,cutPaths,widthMm:box.width/r.ppm,heightMm:box.height/r.ppm,whiteTint:Number.isFinite(r.whiteTint)?r.whiteTint:tintDefault});
      }
    }else if(state.mask&&!state.dirty){
      const box=exportCrop(),artwork=cropCanvas(state.artCanvas,box);
      items.push({name:filenameStem(els.outputName.value),artwork,width:box.width,height:box.height,pixelsPerMm:state.ppm,whitePaths:shiftPaths(state.whitePaths,box),cutPaths:shiftPaths(cutLoopsOrTrace(state.mask,state.w,state.h),box),widthMm:box.width/state.ppm,heightMm:box.height/state.ppm});
    }
    if(!items.length)throw new Error('네스팅할 대상이 없습니다. 배치를 처리하거나 완성된 PDF를 추가하세요.');
    return items;
  }
  function thumbnailDataUrl(canvas,maxW){
    if(!canvas||!canvas.width)return null;
    const w=Math.min(maxW||140,canvas.width),h=Math.max(1,Math.round(canvas.height*w/canvas.width));
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const ctx=c.getContext('2d');ctx.imageSmoothingQuality='high';ctx.drawImage(canvas,0,0,w,h);
    try{return c.toDataURL('image/png');}catch(_){return null;}
  }
  // Search-strategy experiments: ordering, cross-sheet absorb and how wide the
  // beam search runs. Defaults reproduce the classic behaviour exactly.
  const PACK_PRECISION={fast:{beamWidth:2,candidateLimit:8},thorough:{beamWidth:6,candidateLimit:40}};
  function nestingOptions(){return {
    sheetWidthMm:Number($('sheetW')?.value)||400,
    sheetHeightMm:Number($('sheetH')?.value)||300,
    marginMm:1,
    clearanceMm:Number.isFinite(Number($('sheetGap')?.value))?Number($('sheetGap').value):0.25,
    fillBases:$('nestingBaseFill')?.checked!==false,
    baseSizeMm:35,
    extraBases:Number($('extraBaseCount')?.value)||0,
    order:['size-desc','size-asc','auto'].includes($('packOrder')?.value)?$('packOrder').value:'auto',
    absorbLastSheet:$('packAbsorb')?.checked===true,
    ...(PACK_PRECISION[$('packPrecision')?.value||'standard']||{}),
  };}
  function nestingSummary(result,total){
    const pct=(result.utilization*100).toFixed(1);
    const rows=(result.rows||[]).map(r=>`${r.count}개·끝 ${r.endXMm.toFixed(1)}`).join(' / ')||'-';
    return `행 ${result.rowCount}개 [${rows}] · 배치 ${result.placements.length}/${total} · 베이스 ${result.bases.length}개 · 점유율 ${pct}% · 사용 높이 ${result.usedHeightMm.toFixed(1)} mm`;
  }
  // One line per sheet; a single sheet keeps the classic wording verbatim.
  function nestingStatusText(packed){
    const tail=packed.unplaced.length?` · 미배치 ${packed.unplaced.length}개: ${packed.unplaced.map(u=>u.name).join(', ')}`:'';
    if(packed.sheets.length<=1){
      const s=packed.sheets[0];
      return s?nestingSummary(s.result,s.subset.length)+tail:'배치할 수 있는 이미지가 없습니다.'+tail;
    }
    return `시트 ${packed.sheets.length}개 · `+packed.sheets.map((s,i)=>`${i+1}: ${nestingSummary(s.result,s.subset.length)}`).join(' / ')+tail;
  }
  async function previewNesting(){
    const status=$('nestingStatus'),info=$('nestSummaryText');
    try{
      setStatus('네스팅 배치 계산 중…','busy');
      const items=await collectNestingItems();
      const packed=window.OutlineNesting.packSheets(items,nestingOptions());
      if(!packed.sheets.length)throw new Error('시트에 배치할 수 있는 이미지가 없습니다.');
      const baseGeometry=window.OutlineNestingGeometry.createBaseGeometry(Number($('baseTolerance')?.value??0.3));
      lastNesting={
        sheets:packed.sheets.map(s=>({...s,edited:false,baseGeometry,
          labels:s.subset.map(it=>it.name),
          thumbnails:s.subset.map(it=>it.thumb||thumbnailDataUrl(it.artwork,160))})),
        unplaced:packed.unplaced,active:0
      };
      nestSelection=null;nestDrag=null;
      $('nestEditStep')?.removeAttribute('hidden');
      const opt=nestingOptions();
      info.textContent=`${opt.sheetWidthMm} × ${opt.sheetHeightMm} mm`+(packed.sheets.length>1?` · 시트 ${packed.sheets.length}개`:'');
      drawNestingPreview();
      const text=nestingStatusText(packed);
      status.textContent=text;
      setStatus('네스팅 미리보기 완료 · '+text);
    }catch(e){console.error(e);status.textContent='네스팅 미리보기 실패: '+e.message;toast(e.message);}
  }
  async function exportNestingPdf(){
    const status=$('nestingStatus');
    try{
      const names=spotNames();
      setStatus('네스팅 시트 PDF 생성 중…','busy');
      const items=await collectNestingItems();
      // The previewed sheets win when they exist: the operator may have moved,
      // rotated or deleted items and added bases after the automatic pass.
      const packed=(lastNesting&&lastNesting.sheets)?{sheets:lastNesting.sheets,unplaced:lastNesting.unplaced||[]}
        :window.OutlineNesting.packSheets(items,nestingOptions());
      if(!packed.sheets.length)throw new Error('시트에 배치할 수 있는 이미지가 없습니다.');
      const tolerance=Number($('baseTolerance')?.value??0.3);
      const g=window.OutlineNestingGeometry.createBaseGeometry(tolerance);
      const opt=nestingOptions();
      const stem=filenameStem(els.outputName.value);
      const saved=[];
      for(let si=0;si<packed.sheets.length;si++){
        const sheet=packed.sheets[si];
        // The item travels at its own full size. The placed box may be smaller
        // than the artwork canvas, and passing the box size here would rescale
        // the art. Cut/white loops are shifted onto the packer's normalised
        // frame, so the PDF and the preview put the outline exactly where the
        // collision test assumed it.
        const sheetItems=sheet.result.placements.map(p=>{const shift=p.outlineShift||[0,0],src=sheet.subset[p._idx];return {...src,cutPaths:CutVector.shiftLoops(src.cutPaths,shift[0],shift[1]),whitePaths:CutVector.shiftLoops(src.whitePaths,shift[0],shift[1]),xMm:p.xMm,yMm:p.yMm,widthMm:p.sourceWidthMm,heightMm:p.sourceHeightMm,rot:p.rot};});
        const bases=sheet.result.bases.map(b=>({xMm:b.xMm,yMm:b.yMm,outer:g.outer,slit:g.slit}));
        const blob=await OutlinePDF.createSheet({sheetWidthMm:opt.sheetWidthMm,sheetHeightMm:opt.sheetHeightMm,items:sheetItems,bases,whiteName:names.white,cutName:names.cut,whiteTint:tintDefault});
        saved.push(`${stem}-nesting-${opt.sheetWidthMm}x${opt.sheetHeightMm}-s${si+1}.pdf`);
        download(saved[saved.length-1],blob);
        // Browsers throttle back-to-back programmatic downloads.
        if(si<packed.sheets.length-1)await sleep(500);
      }
      const msg=nestingStatusText(packed)+(packed.unplaced.length?' (제외됨)':'');
      status.textContent=msg+` · ${saved.length}개 시트 저장`;
      setStatus(`네스팅 시트 ${saved.length}개 다운로드 완료 · `+msg);
    }catch(e){console.error(e);status.textContent='네스팅 PDF 생성 실패: '+e.message;setStatus('네스팅 PDF 생성 실패: '+e.message,'error');toast(e.message);}
  }


  // ---------------------------------------------------------------------------
  // Nesting sheet: manual editing
  // The automatic pack is only a starting point. On the sheet the operator can
  // drag an item, rotate it 90/180 degrees, delete it, and stamp extra bases.
  // Everything is measured from the same mm coordinates the packer produced, so
  // the PDF writer needs no special case for edited sheets.
  // ---------------------------------------------------------------------------
  let lastNesting = null;            // { sheets: [{ result, subset, labels, thumbnails, baseGeometry, edited }], unplaced, active }
  let nestSelection = null;          // { sheet, kind: 'item' | 'base', index }
  let nestTool = 'select';
  let nestDrag = null;
  const NEST_PAD_MM = 0.6;

  function nestingSheetRect() {
    const opt = nestingOptions();
    return { w: opt.sheetWidthMm, h: opt.sheetHeightMm };
  }
  // The packer caches each placement matrix at pack time. Anything that moves or
  // rotates a placement has to rebuild it, otherwise the dashed box (drawn from
  // xMm/yMm) moves while the artwork, white plate and cut line stay where they
  // were.
  function refreshPlacementMatrix(p) {
    if (!p) return;
    const fn = window.OutlineNesting && window.OutlineNesting.placementMatrix;
    if (fn) p.matrix = fn(p);
  }
  function sheetAt(index) {
    return lastNesting ? lastNesting.sheets[index] || null : null;
  }
  function activeSheet() {
    return sheetAt(lastNesting ? lastNesting.active : 0);
  }
  function selectionSheet() {
    return nestSelection ? sheetAt(nestSelection.sheet) : activeSheet();
  }
  function markNestEdited(sheet) {
    if (!sheet) sheet = selectionSheet();
    if (!sheet) return;
    sheet.edited = true;
    const hint = $('nestSummaryText');
    if (hint) hint.textContent = '수동 수정됨 · 그대로 저장됩니다';
  }
  function selectedPlacement() {
    const sheet = nestSelection && nestSelection.kind === 'item' ? sheetAt(nestSelection.sheet) : null;
    if (!sheet) return null;
    return sheet.result.placements[nestSelection.index] || null;
  }
  function updateNestButtons() {
    const has = !!selectedPlacement();
    ['nestRotateBtn', 'nestFlipBtn', 'nestDeleteBtn'].forEach((id) => { const b = $(id); if (b) b.disabled = !has; });
    document.querySelectorAll('.nest-tools .tool-button').forEach((b) => {
      b.classList.toggle('active', (b.id === 'nestToolBase') === (nestTool === 'base'));
    });
  }
  function drawNestingPreview() {
    if (!lastNesting) return;
    const box = $('nestingPreview');
    if (!box) return;
    // Every sheet the job needs, stacked: the pack fills sheet 1, the leftovers
    // become sheet 2, and so on. Each svg edits its own sheet.
    box.innerHTML = lastNesting.sheets.map((s, i) =>
      `<div class="nest-sheet${i === lastNesting.active ? ' active' : ''}"><h4>시트 ${i + 1}/${lastNesting.sheets.length}</h4>` +
      window.OutlineNesting.nestingPreviewSvg(s.result, {
        labels: s.labels, baseGeometry: s.baseGeometry, thumbnails: s.thumbnails,
      }) + '</div>').join('');
    box.classList.remove('hidden');
    box.querySelectorAll('svg').forEach((svg, i) => {
      svg.dataset.sheet = String(i);
      svg.classList.add('nest-svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `네스팅 시트 ${i + 1} 미리보기 · 끌어서 이동`);
      svg.addEventListener('pointerdown', nestPointerDown);
      svg.addEventListener('pointermove', nestPointerMove);
      svg.addEventListener('pointerup', nestPointerUp);
      svg.addEventListener('pointercancel', nestPointerUp);
    });
    updateNestButtons();
  }
  function svgPointToMm(svg, evt) {
    const r = svg.getBoundingClientRect();
    const w = nestingSheetRect().w;
    if (!r.width) return { x: 0, y: 0 };
    return { x: (evt.clientX - r.left) * (w / r.width), y: (evt.clientY - r.top) * (w / r.width) };
  }
  function hitTestNest(mm, sheet) {
    if (!sheet) sheet = activeSheet();
    if (!sheet) return null;
    const { placements, bases } = sheet.result;
    for (let i = placements.length - 1; i >= 0; i--) {
      const p = placements[i];
      if (mm.x >= p.xMm - NEST_PAD_MM && mm.x <= p.xMm + p.widthMm + NEST_PAD_MM
        && mm.y >= p.yMm - NEST_PAD_MM && mm.y <= p.yMm + p.heightMm + NEST_PAD_MM) return { kind: 'item', index: i };
    }
    for (let i = bases.length - 1; i >= 0; i--) {
      const b = bases[i];
      if (mm.x >= b.xMm - NEST_PAD_MM && mm.x <= b.xMm + 35 + NEST_PAD_MM
        && mm.y >= b.yMm - NEST_PAD_MM && mm.y <= b.yMm + 35 + NEST_PAD_MM) return { kind: 'base', index: i };
    }
    return null;
  }
  function nestPointerDown(evt) {
    if (!lastNesting) return;
    evt.preventDefault();
    const svg = evt.currentTarget;
    const sheetIndex = Number(svg.dataset.sheet || 0);
    lastNesting.active = sheetIndex;
    const sheet = sheetAt(sheetIndex);
    const mm = svgPointToMm(svg, evt);
    if (nestTool === 'base') { addManualBase(mm); return; }
    const hit = hitTestNest(mm, sheet);
    nestSelection = hit ? { sheet: sheetIndex, kind: hit.kind, index: hit.index } : null;
    updateNestButtons();
    if (!nestSelection) return;
    const target = hit.kind === 'item' ? sheet.result.placements[hit.index] : sheet.result.bases[hit.index];
    nestDrag = { sheet: sheetIndex, hit, start: mm, origin: { x: target.xMm, y: target.yMm } };
    svg.setPointerCapture?.(evt.pointerId);
    svg.classList.add('dragging');
  }
  function nestPointerMove(evt) {
    if (!nestDrag) return;
    evt.preventDefault();
    const svg = evt.currentTarget;
    const mm = svgPointToMm(svg, evt);
    const { w, h } = nestingSheetRect();
    const dx = mm.x - nestDrag.start.x, dy = mm.y - nestDrag.start.y;
    const sheet = sheetAt(nestDrag.sheet);
    if (!sheet) return;
    const target = nestDrag.hit.kind === 'item'
      ? sheet.result.placements[nestDrag.hit.index]
      : sheet.result.bases[nestDrag.hit.index];
    const size = nestDrag.hit.kind === 'item' ? { w: target.widthMm, h: target.heightMm } : { w: 35, h: 35 };
    target.xMm = Math.max(0, Math.min(w - size.w, nestDrag.origin.x + dx));
    target.yMm = Math.max(0, Math.min(h - size.h, nestDrag.origin.y + dy));
    if (nestDrag.hit.kind === 'item') refreshPlacementMatrix(target);
    markNestEdited(sheet);
    drawNestingPreview();
  }
  function nestPointerUp() {
    if (!nestDrag) return;
    nestDrag = null;
    document.querySelectorAll('.nest-svg').forEach((s) => s.classList.remove('dragging'));
  }
  function rotatePlacement(step) {
    const p = selectedPlacement();
    if (!p || !lastNesting) return;
    p.rot = ((Number(p.rot) || 0) + step + 360) % 360;
    // A quarter turn swaps the footprint. Keep the item on the sheet.
    if (step % 180 !== 0) {
      const w = p.widthMm, h = p.heightMm;
      p.widthMm = h; p.heightMm = w;
      if (p.xMm + p.widthMm > nestingSheetRect().w) p.xMm = Math.max(0, nestingSheetRect().w - p.widthMm);
      if (p.yMm + p.heightMm > nestingSheetRect().h) p.yMm = Math.max(0, nestingSheetRect().h - p.heightMm);
    }
    refreshPlacementMatrix(p);
    markNestEdited(selectionSheet());
    drawNestingPreview();
  }
  function deleteSelectedPlacement() {
    if (!lastNesting || !nestSelection) return;
    const sheet = sheetAt(nestSelection.sheet);
    if (!sheet) return;
    if (nestSelection.kind === 'item') sheet.result.placements.splice(nestSelection.index, 1);
    else sheet.result.bases.splice(nestSelection.index, 1);
    nestSelection = null;
    sheet.result.placements.forEach(refreshPlacementMatrix);
    markNestEdited(sheet);
    drawNestingPreview();
    const st = $('nestingStatus');
    if (st) st.textContent = nestStatusLine(nestingSummary(sheet.result, sheet.subset.length) + ' · 수동 수정됨');
  }
  // A hand-placed base should not land on top of another base or an item, so a
  // blocked click walks outwards in 35 mm steps until it finds a free pocket.
  function baseSpotFree(x, y, sheet) {
    const { placements, bases } = sheet.result;
    const pad = 0.3;
    const hits = (rx, ry, rw, rh) => x < rx + rw + pad && x + 35 + pad > rx && y < ry + rh + pad && y + 35 + pad > ry;
    for (const b of bases) if (hits(b.xMm, b.yMm, 35, 35)) return false;
    for (const p of placements) if (hits(p.xMm, p.yMm, p.widthMm, p.heightMm)) return false;
    return true;
  }
  function findBaseSpot(x, y, sheet) {
    const { w, h } = nestingSheetRect();
    if (baseSpotFree(x, y, sheet)) return { x, y };
    for (let r = 1; r <= 8; r++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const nx = Math.max(0, Math.min(w - 35, x + dx * 35 * r));
        const ny = Math.max(0, Math.min(h - 35, y + dy * 35 * r));
        if (baseSpotFree(nx, ny, sheet)) return { x: nx, y: ny };
      }
    }
    return null;
  }
  function addManualBase(mm) {
    const sheet = activeSheet();
    if (!sheet) return;
    const { w, h } = nestingSheetRect();
    const wanted = { x: Math.max(0, Math.min(w - 35, mm.x - 17.5)), y: Math.max(0, Math.min(h - 35, mm.y - 17.5)) };
    const spot = findBaseSpot(wanted.x, wanted.y, sheet);
    if (!spot) { toast('베이스를 놓을 빈 자리가 없습니다.'); return; }
    sheet.result.bases.push({ xMm: Math.round(spot.x * 100) / 100, yMm: Math.round(spot.y * 100) / 100, manual: true });
    markNestEdited(sheet);
    drawNestingPreview();
    const st = $('nestingStatus');
    if (st) st.textContent = nestStatusLine(nestingSummary(sheet.result, sheet.subset.length) + ' · 베이스 추가됨');
  }
  function resetNestingEdits() {
    if (!lastNesting) return;
    lastNesting = null; nestSelection = null;
    previewNesting();
  }
  // Manual edits can park an item on top of a base. The packer would never do
  // that, so say so instead of shipping an overlapping sheet quietly.
  function nestOverlapCount() {
    if (!lastNesting) return 0;
    let n = 0;
    for (const sheet of lastNesting.sheets) {
      const { placements, bases } = sheet.result;
      for (const p of placements) {
        for (const b of bases) {
          if (p.xMm < b.xMm + 35 && p.xMm + p.widthMm > b.xMm && p.yMm < b.yMm + 35 && p.yMm + p.heightMm > b.yMm) { n++; break; }
        }
      }
    }
    return n;
  }
  function nestStatusLine(base) {
    const n = nestOverlapCount();
    return base + (n ? ` · ⚠ 베이스 ${n}곳과 겹침` : '');
  }

  async function loadFile(file,slot=-1){if(!file)return;if(state.busy){toast('처리가 끝난 뒤 새 이미지를 선택하세요.');return;}$('workflowStep3').disabled=true;$('workflowStep4').disabled=true;if(!/image\/(png|webp)/.test(file.type)){toast('투명 알파가 있는 PNG 또는 WEBP 이미지를 선택하세요.');return;}const loadVersion=++state.loadVersion;if(slot>=0)batchStore.setActive(slot);state.mask=null;state.autoMask=null;state.whitePaths=[];state.whiteAreaMm2=0;state.history=[];state.metrics=null;state.cutLoops=null;state.cutVectorInfo=null;state.dirty=false;state.artCanvas=null;state.overlayCanvas=null;setEnabled(false);updateWhiteInfo();resetScaffoldInfo();els.processBtn.disabled=true;state.file=file;state.sourceName=file.name;if(!state.customFileName)els.outputName.value=filenameStem(file.name.replace(/\.(?:png|webp)$/i,''));
    try{const bitmap=await createImageBitmap(file);if(loadVersion!==state.loadVersion){bitmap.close();return;}if(state.sourceBitmap)state.sourceBitmap.close();state.sourceBitmap=bitmap;const tmp=document.createElement('canvas');tmp.width=bitmap.width;tmp.height=bitmap.height;tmp.getContext('2d').drawImage(bitmap,0,0);const data=tmp.getContext('2d').getImageData(0,0,tmp.width,tmp.height).data;let minX=tmp.width,minY=tmp.height,maxX=-1,maxY=-1,hasTransparency=false;for(let y=0;y<tmp.height;y++)for(let x=0;x<tmp.width;x++){const a=data[(y*tmp.width+x)*4+3];if(a<250)hasTransparency=true;if(a>1){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}
      if(maxX<minX)throw new Error('alpha 채널에서 전경을 찾을 수 없습니다.');if(!hasTransparency){state.file=null;els.processBtn.disabled=true;setStatus('투명 알파가 없습니다. 배경이 제거된 PNG/WEBP를 선택하세요.','error');toast('투명 알파가 있는 입력이 필요합니다.');return;}const cw=maxX-minX+1,ch=maxY-minY+1;const crop=document.createElement('canvas');crop.width=cw;crop.height=ch;
      // Mirror happens here, on the cropped pixels, so every downstream stage
      // (silhouette, white spot, scaffold, preview, PDF) follows automatically.
      const cctx=crop.getContext('2d');
      if(state.flipX){cctx.translate(cw,0);cctx.scale(-1,1);}
      cctx.drawImage(tmp,minX,minY,cw,ch,0,0,cw,ch);
      state.croppedCanvas=crop;
      els.fileMeta.classList.remove('hidden');els.fileMeta.innerHTML=`<b>${escapeHtml(file.name)}</b><br>${bitmap.width} × ${bitmap.height}px · alpha bbox ${cw} × ${ch}px`;
      els.processBtn.disabled=false;setStatus('이미지 준비 완료 · 설정을 확인하고 파이프라인을 실행하세요.');toast('이미지를 브라우저 메모리에 불러왔습니다.');
      // Fast preview before processing.
      els.canvasWrap.classList.remove('empty-state');els.canvasWrap.classList.add('has-image');const ctx=els.canvas.getContext('2d');els.canvas.width=bitmap.width;els.canvas.height=bitmap.height;
      if(state.flipX){ctx.translate(bitmap.width,0);ctx.scale(-1,1);}
      ctx.drawImage(bitmap,0,0);
    }catch(e){if(loadVersion===state.loadVersion)setStatus('이미지 읽기 실패: '+e.message,'error');}
  }
  // RLE lives in rle.js now; keep the local names for call sites.
  const {packMask,unpackMask}=OutlineRle;
  function blobFromCanvas(canvas){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('이미지 압축 실패')),'image/png'));}
  async function saveBatchInto(index){
    if(!batchStore.inRange(index)||!state.mask||!state.artCanvas)return;
    // Capture the whole item synchronously. The await below must never re-read
    // `state`, otherwise a tab switch mid-save mixes two items together.
    const prevRec=batchStore.ref(index);
    const snapshot={whiteTint:prevRec&&Number.isFinite(prevRec.whiteTint)?prevRec.whiteTint:tintDefault,name:batchFiles[index]?.name||state.sourceName,settingsKey:settingsKey(),sourceName:state.sourceName,w:state.w,h:state.h,ppm:state.ppm,maskRle:packMask(state.mask),autoRle:packMask(state.autoMask||state.mask),whitePaths:JSON.parse(JSON.stringify(state.whitePaths)),whiteAreaMm2:state.whiteAreaMm2,metrics:JSON.parse(JSON.stringify(state.metrics||{})),outputName:els.outputName.value,customFileName:state.customFileName,dirty:state.dirty,history:state.history.map(packMask),cutLoops:state.cutLoops?JSON.parse(JSON.stringify(state.cutLoops)):null,file:batchFiles[index],pixels:state.w*state.h};
    const canvas=state.artCanvas;
    snapshot.artBlob=await blobFromCanvas(canvas);
    batchStore.put(index,snapshot);
    renderBatchQueue();
  }
  async function restoreBatchItem(index){
    const r=batchStore.get(index);if(!r)return;batchStore.setActive(index);
    // RenderState stages the whole item, then publishes it in one step. If the
    // user clicks again while we decode, the older commit is dropped instead of
    // publishing a mask next to another item's white paths.
    await renderState.commit(async()=>{
      const bmp=await createImageBitmap(r.artBlob);
      const artCanvas=document.createElement('canvas');artCanvas.width=r.w;artCanvas.height=r.h;artCanvas.getContext('2d').drawImage(bmp,0,0);bmp.close();
      const overlayCanvas=document.createElement('canvas');overlayCanvas.width=r.w;overlayCanvas.height=r.h;
      return {sourceName:r.sourceName,file:r.file,w:r.w,h:r.h,ppm:r.ppm,mask:unpackMask(r.maskRle,r.pixels),autoMask:unpackMask(r.autoRle||r.maskRle,r.pixels),artCanvas,overlayCanvas,whitePaths:JSON.parse(JSON.stringify(r.whitePaths)),whiteAreaMm2:r.whiteAreaMm2,metrics:JSON.parse(JSON.stringify(r.metrics)),dirty:r.dirty,history:r.history.map(x=>unpackMask(x,r.pixels)),cutLoops:r.cutLoops?JSON.parse(JSON.stringify(r.cutLoops)):null,customFileName:r.customFileName};
    });
    if(batchStore.active!==index)return;
    syncTintSlider();
    els.outputName.value=r.outputName;els.fileMeta.classList.remove('hidden');els.fileMeta.innerHTML=`<b>${escapeHtml(r.name)}</b><br>배치 결과 ${index+1}/${batchFiles.length}`;
    els.processBtn.disabled=false;setEnabled(!state.dirty);render();refreshMetrics();updateWhiteInfo();renderBatchQueue();
  }
  function renderBatchQueue(){
    updateTintScope();
    const bar=$('batchQueueBar'),btn=$('batchProcessBtn');if(!bar)return;
    const many=batchFiles.length>1;bar.classList.toggle('hidden',!many);btn.classList.toggle('hidden',!many);
    btn.disabled=batchBusy||!many;btn.textContent=batchBusy?'배치 처리 중…':`전체 ${batchFiles.length}개 처리`;
    if(!many){bar.innerHTML='';return;}
    const active=batchStore.active;
    bar.innerHTML=`<div class="batch-head"><b>이미지 배치</b><span>${batchStore.completedCount()}/${batchFiles.length} 처리 완료</span></div><div class="batch-items">${batchFiles.map((f,i)=>`<button type="button" class="batch-item ${i===active?'active':''} ${batchStore.has(i)?'done':''}" data-batch-index="${i}" title="${escapeHtml(f.name)}"><span>${batchStore.has(i)?'✓':String(i+1).padStart(2,'0')}</span>${escapeHtml(f.name)}</button>`).join('')}</div><small>공통 설정 · 결과는 목록에서 하나씩 미리보기/편집하고 각자 내보냅니다.</small>`;
    bar.querySelectorAll('[data-batch-index]').forEach(b=>{
      b.disabled=batchBusy;
      b.addEventListener('click',()=>withEditor(()=>selectBatchItem(Number(b.dataset.batchIndex))));
    });
  }
  async function selectBatchItem(i){
    if(i===batchStore.active)return;
    if(state.mask&&batchStore.active>=0)await saveBatchInto(batchStore.active);
    if(batchStore.has(i)){await restoreBatchItem(i);return;}
    batchStore.setActive(i);state.customFileName=false;
    await loadFile(batchFiles[i],i);syncTintSlider();
    renderBatchQueue();
  }

  async function processBatch(){if(batchBusy||batchFiles.length<2)return;batchBusy=true;$('batchProcessBtn').disabled=true;renderBatchQueue();
    const gen=batchGeneration;const files=batchFiles.slice();
    try{
    if(state.mask&&batchStore.active>=0)await saveBatchInto(batchStore.active);
    for(let i=0;i<files.length;i++){
      if(gen!==batchGeneration){setStatus('새 이미지 목록으로 교체되어 배치를 중단했습니다.');break;}
      const cached=batchStore.get(i);
      // Reuse a stored result only if it was produced with the current settings.
      if(cached&&cached.maskRle&&cached.settingsKey===settingsKey())continue;
      if(cached&&!cached.maskRle)continue;
      state.customFileName=false;setStatus(`배치 처리 ${i+1}/${files.length} · ${files[i].name}`,'busy');
      // Each item is isolated: one bad file must never take the batch down.
      try{
        await loadFile(files[i],i);
        if(!state.file||!state.croppedCanvas)throw new Error('이미지 알파 또는 디코딩 오류');
        await processPipeline();
        if(!state.mask)throw new Error(els.status.textContent||'결과를 만들지 못했습니다.');
        if(gen===batchGeneration)await saveBatchInto(i);
      }catch(err){
        if(gen===batchGeneration)batchStore.put(i,{name:files[i].name,error:err&&err.message?err.message:String(err),file:files[i]});
      }
      renderBatchQueue();
    }
    if(gen!==batchGeneration)return;
    const first=files.findIndex((f,i)=>batchStore.get(i)?.maskRle);if(first>=0)await restoreBatchItem(first);
    const ready=files.filter((f,i)=>batchStore.get(i)?.maskRle).length;
    setStatus(`배치 완료 · ${ready}/${files.length}개 결과 준비됨`);
  }finally{batchBusy=false;renderBatchQueue();}}
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  // One numbered flow (1 업로드 · 2 세부설정 · 3 편집 · 4 내보내기): the top nav
  // and the sidebar/workspace badges share it; nav buttons scroll to the step.
  document.querySelectorAll('.workflow-step[data-goto]').forEach(btn=>btn.addEventListener('click',()=>{
    if(btn.disabled)return;
    const t=document.getElementById(btn.dataset.goto);
    if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
    document.querySelectorAll('.workflow-step').forEach(b=>{
      const on=b===btn;
      b.classList.toggle('active',on);
      if(on)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');
    });
  }));
  document.querySelectorAll('.layer-toggle').forEach(btn=>btn.addEventListener('click',()=>{const layer=btn.dataset.layer,key=layer==='art'?'showArt':layer==='white'?'showWhite':'showCut';state[key]=!state[key];if(layer==='white')els.whitePreview.checked=state.showWhite;btn.classList.toggle('active',state[key]);btn.setAttribute('aria-pressed',String(state[key]));btn.querySelector('.eye').textContent=state[key]?'◉':'○';render();}));
  els.fileInput.addEventListener('change',async e=>{const files=Array.from(e.target.files||[]);e.target.value='';if(!files.length)return;batchGeneration++;   // stop any running batch immediately
   withEditor(async()=>{batchFiles=files;batchStore.reset(files.length);batchStore.setActive(0);state.customFileName=false;renderBatchQueue();await loadFile(files[0],0);});});
  els.processBtn.addEventListener('click',()=>withEditor(async()=>{await processPipeline();if(batchStore.active>=0&&batchFiles.length>1&&state.mask)await saveBatchInto(batchStore.active);}));
  $('batchProcessBtn').addEventListener('click',()=>withEditor(processBatch));
  els.brushTool.addEventListener('click',()=>setTool('brush'));els.eraserTool.addEventListener('click',()=>setTool('eraser'));
  els.brushSize.addEventListener('input',()=>{els.brushSizeText.value=Number(els.brushSize.value).toFixed(1).replace(/\.0$/,'')+' mm';render();});
  els.undoBtn.addEventListener('click',undo);els.resetEditsBtn.addEventListener('click',resetEdits);els.fitBtn.addEventListener('click',()=>{els.canvas.style.maxWidth='100%';els.canvas.style.maxHeight='100%';});
  els.pdfBtn.addEventListener('click',exportPdf);els.svgBtn.addEventListener('click',exportSvg);els.pngBtn.addEventListener('click',exportPng);els.jsonBtn.addEventListener('click',exportJson);
  // Mirroring invalidates the current result. Re-derive it from the source image
  // instead of trying to mirror the mask after the fact.
  $('flipX')?.addEventListener('change',async(e)=>{
    state.flipX=!!e.target.checked;
    if(!state.file)return;
    const slot=batchStore.active>=0?batchStore.active:-1;
    await loadFile(state.file,slot);
    if(state.flipX!==!!$('flipX').checked)return;
    if(state.croppedCanvas){markPipelineDirty();await processPipeline();}
    else setStatus('이미지를 다시 불러오지 못했습니다.','error');
  });
  $('nestingPreviewBtn')?.addEventListener('click',previewNesting);$('nestingPdfBtn')?.addEventListener('click',exportNestingPdf);
  // One export panel, two destinations: the operator picks single piece or
  // nesting sheet and only the controls for that choice stay on screen.
  function setExportMode(mode){
    state.exportMode=mode==='sheet'?'sheet':'single';
    const sheet=state.exportMode==='sheet';
    els.modeSingle?.classList.toggle('active',!sheet);
    els.modeSheet?.classList.toggle('active',sheet);
    if(els.modeSingle)els.modeSingle.setAttribute('aria-pressed',String(!sheet));
    if(els.modeSheet)els.modeSheet.setAttribute('aria-pressed',String(sheet));
    if(els.singleExportBox)els.singleExportBox.hidden=sheet;
    if(els.sheetExportBox)els.sheetExportBox.hidden=!sheet;
    if(els.expoSummary)els.expoSummary.textContent=sheet?'배치 · 시트 PDF':'PDF · SVG · PNG';
  }
  els.modeSingle?.addEventListener('click',()=>setExportMode('single'));
  els.modeSheet?.addEventListener('click',()=>setExportMode('sheet'));
  setExportMode('single');
  $('pdfImportInput')?.addEventListener('change',async(e)=>{const files=[...(e.target.files||[])];e.target.value='';await importFinishedPdfs(files);});
  $('pdfImportClear')?.addEventListener('click',()=>{pdfNestingItems.length=0;renderPdfImportList();$('nestingPreview')?.classList.add('hidden');const st=$('nestingStatus');if(st)st.textContent='';toast('가져온 PDF를 비웠습니다.');});
  els.whiteSwatch.addEventListener('change',()=>{const custom=els.whiteSwatch.value==='custom';els.whiteCustomWrap.classList.toggle('hidden',!custom);if(custom)els.whiteCustom.focus();});
  els.whitePreview.addEventListener('change',()=>{state.showWhite=els.whitePreview.checked;const btn=document.querySelector('.layer-toggle[data-layer="white"]');if(btn){btn.classList.toggle('active',state.showWhite);btn.setAttribute('aria-pressed',String(state.showWhite));btn.querySelector('.eye').textContent=state.showWhite?'◉':'○';}render();});els.outputName.addEventListener('input',()=>{state.customFileName=true;});
  els.editWhiteTint?.addEventListener('input',()=>{
    const v=Number(els.editWhiteTint.value),cl=Number.isFinite(v)?Math.max(0,Math.min(100,v)):100;
    if(activeRecord())batchStore.update(batchStore.active,{whiteTint:cl});else tintDefault=cl;
    updateWhiteTintLabel();render();
  });
  els.editWhiteTint?.addEventListener('change',updateWhiteTintLabel);
  updateWhiteTintLabel();
  SETTING_IDS.forEach(id=>$(id).addEventListener('input',markPipelineDirty));
  els.canvas.addEventListener('pointerdown',pointerDown);els.canvas.addEventListener('pointermove',pointerMove);els.canvas.addEventListener('pointerup',pointerUp);els.canvas.addEventListener('pointercancel',pointerUp);els.canvas.addEventListener('pointerleave',()=>{if(!state.painting){state.cursor=null;render();}});

  $('nestToolSelect')?.addEventListener('click',()=>{nestTool='select';updateNestButtons();});
  $('nestToolBase')?.addEventListener('click',()=>{nestTool='base';updateNestButtons();});
  $('nestRotateBtn')?.addEventListener('click',()=>rotatePlacement(90));
  $('nestFlipBtn')?.addEventListener('click',()=>rotatePlacement(180));
  $('nestDeleteBtn')?.addEventListener('click',deleteSelectedPlacement);
  $('nestResetBtn')?.addEventListener('click',resetNestingEdits);
  $('basePlus')?.addEventListener('click',()=>{const i=$('extraBaseCount');if(!i)return;i.value=String(Math.min(200,(Number(i.value)||0)+1));markExtraBases();});
  $('baseMinus')?.addEventListener('click',()=>{const i=$('extraBaseCount');if(!i)return;i.value=String(Math.max(0,(Number(i.value)||0)-1));markExtraBases();});
  $('extraBaseCount')?.addEventListener('input',()=>{markExtraBases();});
  function markExtraBases(){const n=Number($('extraBaseCount')?.value)||0;const note=$('baseCountNote');if(note)note.textContent=n?`자동 베이스에 ${n}개 더 놓습니다`:'자동으로 채운 베이스에 더합니다';}
  markExtraBases();
  const resetNestingPreview=()=>{if(lastNesting){lastNesting=null;nestSelection=null;updateNestButtons();$('nestingPreview')?.classList.add('hidden');$('nestEditStep')?.setAttribute('hidden','');}};
  ['sheetW','sheetH','sheetGap'].forEach((id)=>$(id)?.addEventListener('input',resetNestingPreview));
  ['packOrder','packPrecision'].forEach((id)=>$(id)?.addEventListener('change',resetNestingPreview));
  $('packAbsorb')?.addEventListener('change',resetNestingPreview);

  // Test/bench hook: lets a harness pack the very items the UI would pack.
  window.OutlineApp={collectNestingItems,nestingOptions};

  window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}});
  for(const ev of ['dragenter','dragover'])els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.add('dragover');});
  for(const ev of ['dragleave','drop'])els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.remove('dragover');});
  els.dropZone.addEventListener('drop',e=>{const f=e.dataTransfer.files?.[0];if(!f)return;batchGeneration++;withEditor(async()=>{batchFiles=[f];batchStore.reset(1);batchStore.setActive(0);await loadFile(f,0);});});
})();
