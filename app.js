(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput:$('fileInput'),dropZone:$('dropZone'),fileMeta:$('fileMeta'),processBtn:$('processBtn'),status:$('pipelineStatus'),
    canvasWrap:$('canvasWrap'),canvas:$('editorCanvas'),emptyMessage:$('emptyMessage'),brushTool:$('brushTool'),eraserTool:$('eraserTool'),
    brushSize:$('brushSize'),brushSizeText:$('brushSizeText'),undoBtn:$('undoBtn'),resetEditsBtn:$('resetEditsBtn'),fitBtn:$('fitBtn'),
    svgBtn:$('svgBtn'),pngBtn:$('pngBtn'),jsonBtn:$('jsonBtn'),toast:$('toast'),
    metricStatus:$('metricStatus'),metricSize:$('metricSize'),metricComponents:$('metricComponents'),metricHoles:$('metricHoles'),metricWebs:$('metricWebs')
  };
  const state={file:null,sourceBitmap:null,artCanvas:null,overlayCanvas:null,w:0,h:0,ppm:0,artMask:null,autoMask:null,mask:null,tool:'brush',painting:false,lastPoint:null,history:[],metrics:null,sourceName:'',cursor:null};
  const DPI=300, ACTIVE_HEIGHT_BASE=141.5, PAD_MM=10, MIN_AREA_MM2=1, MIN_CORE_MM2=25;
  let toastTimer=0;

  function settings(){
    const height=Number($('heightInput').value)||148.5;
    const tabDepth=Number($('tabDepthInput').value)||3;
    const offset=Number($('offsetInput').value)||0;
    return {targetHeight:height,offset,webWidth:Number($('webInput').value)||10,gap:Number($('gapInput').value)||4,
      scaffold:Number($('scaffoldInput').value)||50,tabWidth:Number($('tabWidthInput').value)||30,tabDepth,
      taper:Number($('taperInput').value)||1,tipR:Number($('tipRadiusInput').value)||.75,
      speck:Number($('speckInput').value)||1,alpha:Number($('alphaInput').value)||8};
  }
  function setStatus(text,kind=''){els.status.textContent=text;els.status.className='status-line '+kind;}
  function toast(text){els.toast.textContent=text;els.toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>els.toast.classList.remove('show'),2200);}
  function setStage(index){document.querySelectorAll('.pipeline-list li').forEach((li,i)=>{li.classList.toggle('done',i<index);li.classList.toggle('active',i===index);});}
  function setEnabled(on){[els.brushTool,els.eraserTool,els.brushSize,els.undoBtn,els.resetEditsBtn,els.fitBtn,els.svgBtn,els.pngBtn,els.jsonBtn].forEach(x=>x.disabled=!on);}
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
    ctx.beginPath();ctx.moveTo((cx-half)*ppm,bottom*ppm);ctx.lineTo((cx+half)*ppm,bottom*ppm);ctx.lineTo((cx+half)*ppm,(bottom+depth-r)*ppm);ctx.quadraticCurveTo((cx+half)*ppm,(bottom+depth)*ppm,(cx+half-r)*ppm,(bottom+depth)*ppm);ctx.lineTo((cx-half+taper+r)*ppm,(bottom+depth)*ppm);ctx.quadraticCurveTo((cx-half+taper)*ppm,(bottom+depth)*ppm,(cx-half+taper)*ppm,(bottom+depth-r)*ppm);ctx.lineTo((cx-half)*ppm,bottom*ppm);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();
    const data=ctx.getImageData(0,0,w,h).data,out=mask.slice();for(let i=0;i<out.length;i++)if(data[i*4+3]>0)out[i]=1;return out;
  }
  function findCrossings(mask,w,h,x){const out=[];x=Math.round(x);if(x<1||x>=w-1)return out;for(let y=1;y<h-1;y++){if(mask[y*w+x]!==mask[(y-1)*w+x])out.push([x,y]);}return out;}
  function localJunctionBlend(mask,w,h,ppm,cx,top,bottom,scaffoldWidth){const crossings=[...findCrossings(mask,w,h,cx-scaffoldWidth*ppm/2),...findCrossings(mask,w,h,cx+scaffoldWidth*ppm/2)];if(!crossings.length)return {mask,junctions:0};const smooth=closing(mask,w,h,1.5*ppm),out=mask.slice(),r=5*ppm,r2=r*r;for(const [x,y] of crossings){const x0=Math.max(0,Math.floor(x-r)),x1=Math.min(w-1,Math.ceil(x+r)),y0=Math.max(0,Math.floor(y-r)),y1=Math.min(h-1,Math.ceil(y+r));for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){const dx=xx-x,dy=yy-y;if(dx*dx+dy*dy<=r2)out[yy*w+xx]=smooth[yy*w+xx];}}return {mask:out,junctions:crossings.length};}

  async function processPipeline(){
    if(!state.file)return;const s=settings();const activeHeight=s.targetHeight-2*s.offset-s.tabDepth;
    if(activeHeight<=10){toast('최종 높이가 외곽 여유·탭보다 너무 작습니다.');return;}
    setEnabled(false);els.processBtn.disabled=true;setStatus('알파 마스크 정리 중…','busy');setStage(0);await sleep();
    try{
      const nominalPpm=DPI/25.4,targetPx=Math.round(activeHeight*nominalPpm),crop=state.croppedCanvas;
      const scaledW=Math.max(1,Math.round(crop.width*targetPx/crop.height));const scaled=document.createElement('canvas');scaled.width=scaledW;scaled.height=targetPx;scaled.getContext('2d').drawImage(crop,0,0,scaledW,targetPx);
      const scaledData=scaled.getContext('2d').getImageData(0,0,scaledW,targetPx).data;let minX=scaledW,minY=targetPx,maxX=-1,maxY=-1;
      for(let y=0;y<targetPx;y++)for(let x=0;x<scaledW;x++)if(scaledData[(y*scaledW+x)*4+3]>s.alpha){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
      if(maxY<minY)throw new Error('알파 임계값보다 높은 전경 픽셀이 없습니다.');
      const activePxH=maxY-minY+1,ppm=activePxH/activeHeight,pad=Math.ceil(PAD_MM*nominalPpm),w=scaledW+pad*2,h=targetPx+pad*2;
      const art=document.createElement('canvas');art.width=w;art.height=h;art.getContext('2d').drawImage(scaled,pad,pad);state.artCanvas=art;state.w=w;state.h=h;state.ppm=ppm;
      const rgba=art.getContext('2d').getImageData(0,0,w,h).data,mask=new Uint8Array(w*h);for(let i=0;i<mask.length;i++)mask[i]=rgba[i*4+3]>s.alpha?1:0;
      const cleaned=removeSmall(mask,w,h,ppm,s.speck),filled=fillHoles(cleaned.mask,w,h);state.artMask=filled.mask;
      setStage(1);setStatus('2mm 외곽 오프셋 및 목 연결 감지…','busy');await sleep();
      let outline=dilate(state.artMask,w,h,s.offset*ppm);const beforeWebs=outline.slice();
      const neck=detectNecks(outline,w,h,ppm,s.webWidth);outline=neck.mask;
      setStage(2);setStatus('센터탭 Boolean 및 4mm gap-fill…','busy');await sleep();
      const baseStats=stats(outline,w,h);if(baseStats.area===0)throw new Error('실루엣 마스크가 비었습니다.');
      const rect=roundedRectMask(w,h,baseStats.cx,baseStats.minY,baseStats.maxY+1,s.scaffold*ppm,3*ppm);
      const rectOnly=new Uint8Array(w*h);for(let i=0;i<rectOnly.length;i++)rectOnly[i]=rect[i]&&!outline[i]?1:0;
      const cells=components(rectOnly,w,h,0,false),cellKeep=new Uint8Array(w*h),upperEnd=baseStats.minY+(baseStats.height/3);let keptCells=0,droppedCells=0;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const id=cells.labels[y*w+x];if(!id)continue;const c=cells.items[id-1];if(y<=upperEnd)c.upperHit=true;}
      for(const c of cells.items){if(c.upperHit)droppedCells++;else keptCells++;}
      for(let i=0;i<cellKeep.length;i++){const id=cells.labels[i];if(id&&!cells.items[id-1].upperHit)cellKeep[i]=1;}
      let scaffoldUnion=outline.slice();for(let i=0;i<scaffoldUnion.length;i++)if(cellKeep[i])scaffoldUnion[i]=1;
      const gapRadius=(s.gap/2)*ppm;let closed=scaffoldUnion;if(s.gap>0)closed=closing(scaffoldUnion,w,h,gapRadius);
      let gapPixels=0;for(let i=0;i<closed.length;i++)if(closed[i]&&!scaffoldUnion[i])gapPixels++;
      const blend=localJunctionBlend(closed,w,h,ppm,baseStats.cx,baseStats.minY,baseStats.maxY,s.scaffold);
      const withTab=addTab(blend.mask,w,h,baseStats.cx/ppm,(baseStats.maxY+1)/ppm,ppm,s);
      const cleanedFinal=removeSmall(withTab,w,h,ppm,s.speck).mask;const finalFilled=fillHoles(cleanedFinal,w,h);state.mask=finalFilled.mask;state.autoMask=state.mask.slice();state.history=[];
      const webAdded=beforeWebs.reduce((a,v,i)=>a+((!v&&outline[i])?1:0),0)/(ppm*ppm);
      state.metrics={source:state.sourceName,activeArtworkHeightMm:activeHeight,pixelsPerMm:ppm,globalOuterOffsetMm:s.offset,targetOverallCutHeightMm:s.targetHeight,
        actualCutSizeMm:null,componentsRemoved:cleaned.removed,componentsKept:cleaned.kept,initialHolesFilled:filled.holes,neckCoreCount:neck.cores,
        detectedWebCount:neck.webs.length,detectedWebs:neck.webs.map(x=>({...x,fromPx:x.fromPx.map(v=>v/ppm),toPx:x.toPx.map(v=>v/ppm)})),neckWebAddedAreaMm2:webAdded,
        scaffoldWidthMm:s.scaffold,deletedUpperThirdCells:droppedCells,retainedCells:keptCells,gapFillThresholdMm:s.gap,gapFillAreaMm2:gapPixels/(ppm*ppm),
        junctionBlendCount:blend.junctions,tabWidthMm:s.tabWidth,tabDepthMm:s.tabDepth,tabTaperMm:s.taper,tabTipRadiusMm:s.tipR,finalHolesFilled:finalFilled.holes};
      state.overlayCanvas=document.createElement('canvas');state.overlayCanvas.width=w;state.overlayCanvas.height=h;
      setStage(3);render();refreshMetrics();setEnabled(true);els.processBtn.disabled=false;setStatus('처리 완료 · 브러시/지우개로 직접 수정할 수 있습니다.');toast('파이프라인 완료');
    }catch(err){console.error(err);setStatus('오류: '+(err.message||err),'error');els.processBtn.disabled=false;setEnabled(!!state.mask);}
  }

  function maskStats(){if(!state.mask)return null;const s=stats(state.mask,state.w,state.h),cc=components(state.mask,state.w,state.h,0,false);const noHoles=fillHoles(state.mask,state.w,state.h);let holes=0;for(let i=0;i<state.mask.length;i++)if(noHoles.mask[i]&&!state.mask[i])holes++;return {...s,components:cc.items.length,holes};}
  function refreshMetrics(){if(!state.mask)return;const m=maskStats(),ppm=state.ppm,actualH=m.height/ppm,actualW=m.width/ppm;state.metrics.actualCutSizeMm=[actualW,actualH];els.metricStatus.textContent=(m.components===1&&m.holes===0)?'PASS':'검토 필요';els.metricStatus.style.color=(m.components===1&&m.holes===0)?'#15976f':'#d28524';els.metricSize.textContent=`${actualW.toFixed(1)} × ${actualH.toFixed(1)} mm`;els.metricComponents.textContent=String(m.components);els.metricHoles.textContent=String(m.holes);els.metricWebs.textContent=String(state.metrics.detectedWebCount||0);}
  let renderQueued=false;
  function scheduleRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render();});}
  function render(){if(!state.mask||!state.artCanvas)return;const canvas=els.canvas,ctx=canvas.getContext('2d');canvas.width=state.w;canvas.height=state.h;ctx.clearRect(0,0,state.w,state.h);ctx.drawImage(state.artCanvas,0,0);
    const id=ctx.createImageData(state.w,state.h),d=id.data,w=state.w,h=state.h,m=state.mask;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(!m[i])continue;const p=i*4;const edge=(x===0||x===w-1||y===0||y===h-1||!m[i-1]||!m[i+1]||!m[i-w]||!m[i+w]);if(edge){d[p]=242;d[p+1]=26;d[p+2]=155;d[p+3]=255;}else{d[p]=36;d[p+1]=178;d[p+2]=139;d[p+3]=42;}}
    state.overlayCanvas.getContext('2d').putImageData(id,0,0);ctx.drawImage(state.overlayCanvas,0,0);
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
  function maskToSvgPath(){const loops=boundaryLoops(state.mask,state.w,state.h),ppm=state.ppm;return loops.map(r=>`M ${r[0][0]/ppm} ${r[0][1]/ppm} `+r.slice(1).map(p=>`L ${p[0]/ppm} ${p[1]/ppm}`).join(' ')+' Z').join(' ');}
  function download(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1200);}
  function exportSvg(){if(!state.mask)return;setStatus('SVG 경로 생성 중…','busy');setTimeout(()=>{try{const path=maskToSvgPath(),s=stats(state.mask,state.w,state.h),width=state.w/state.ppm,height=state.h/state.ppm;const artUrl=state.artCanvas.toDataURL('image/png');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(4)}mm" height="${height.toFixed(4)}mm" viewBox="0 0 ${state.w} ${state.h}"><image x="0" y="0" width="${state.w}" height="${state.h}" href="${artUrl}"/><path d="${path}" fill="none" stroke="#f21a9b" stroke-width="0.2mm" stroke-linejoin="round" stroke-linecap="round"/></svg>`;download('outline-studio-cutline.svg',new Blob([svg],{type:'image/svg+xml'}));setStatus('SVG 다운로드 완료.');}catch(e){console.error(e);setStatus('SVG 생성 실패: '+e.message,'error');}},30);}
  function exportPng(){if(!state.mask)return;const c=document.createElement('canvas');c.width=state.w;c.height=state.h;const ctx=c.getContext('2d');ctx.drawImage(state.artCanvas,0,0);const loops=boundaryLoops(state.mask,state.w,state.h);ctx.beginPath();for(const r of loops){ctx.moveTo(r[0][0],r[0][1]);for(let i=1;i<r.length;i++)ctx.lineTo(r[i][0],r[i][1]);ctx.closePath();}ctx.strokeStyle='#f21a9b';ctx.lineWidth=Math.max(2,.2*state.ppm);ctx.lineJoin='round';ctx.stroke();c.toBlob(b=>download('outline-studio-preview.png',b),'image/png');}
  function exportJson(){if(!state.mask)return;const current=maskStats();const report={...state.metrics,source:state.sourceName,actualCutSizeMm:[current.width/state.ppm,current.height/state.ppm],connectedComponents:current.components,internalHoles:current.holes,manualEdits:state.history.length>0,clientOnly:true};download('outline-studio-metrics.json',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));}

  async function loadFile(file){if(!file)return;if(!/image\/(png|webp)/.test(file.type)){toast('투명 알파가 있는 PNG 또는 WEBP 이미지를 선택하세요.');return;}state.mask=null;state.autoMask=null;state.history=[];state.metrics=null;setEnabled(false);els.processBtn.disabled=true;state.file=file;state.sourceName=file.name;
    try{const bitmap=await createImageBitmap(file);state.sourceBitmap=bitmap;const tmp=document.createElement('canvas');tmp.width=bitmap.width;tmp.height=bitmap.height;tmp.getContext('2d').drawImage(bitmap,0,0);const data=tmp.getContext('2d').getImageData(0,0,tmp.width,tmp.height).data;let minX=tmp.width,minY=tmp.height,maxX=-1,maxY=-1,hasTransparency=false;for(let y=0;y<tmp.height;y++)for(let x=0;x<tmp.width;x++){const a=data[(y*tmp.width+x)*4+3];if(a<250)hasTransparency=true;if(a>1){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}
      if(maxX<minX)throw new Error('alpha 채널에서 전경을 찾을 수 없습니다.');if(!hasTransparency){state.file=null;els.processBtn.disabled=true;setStatus('투명 알파가 없습니다. 배경이 제거된 PNG/WEBP를 선택하세요.','error');toast('투명 알파가 있는 입력이 필요합니다.');return;}const cw=maxX-minX+1,ch=maxY-minY+1;const crop=document.createElement('canvas');crop.width=cw;crop.height=ch;crop.getContext('2d').drawImage(tmp,minX,minY,cw,ch,0,0,cw,ch);state.croppedCanvas=crop;
      els.fileMeta.classList.remove('hidden');els.fileMeta.innerHTML=`<b>${escapeHtml(file.name)}</b><br>${bitmap.width} × ${bitmap.height}px · alpha bbox ${cw} × ${ch}px`;
      els.processBtn.disabled=false;setStatus('이미지 준비 완료 · 설정을 확인하고 파이프라인을 실행하세요.');toast('이미지를 브라우저 메모리에 불러왔습니다.');
      // Fast preview before processing.
      els.canvasWrap.classList.remove('empty-state');els.canvasWrap.classList.add('has-image');const ctx=els.canvas.getContext('2d');els.canvas.width=bitmap.width;els.canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);els.canvas.style.display='block';
    }catch(e){setStatus('이미지 읽기 실패: '+e.message,'error');}
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  els.fileInput.addEventListener('change',e=>loadFile(e.target.files?.[0]));
  els.processBtn.addEventListener('click',processPipeline);
  els.brushTool.addEventListener('click',()=>setTool('brush'));els.eraserTool.addEventListener('click',()=>setTool('eraser'));
  els.brushSize.addEventListener('input',()=>{els.brushSizeText.value=Number(els.brushSize.value).toFixed(1).replace(/\.0$/,'')+' mm';render();});
  els.undoBtn.addEventListener('click',undo);els.resetEditsBtn.addEventListener('click',resetEdits);els.fitBtn.addEventListener('click',()=>{els.canvas.style.maxWidth='100%';els.canvas.style.maxHeight='100%';});
  els.svgBtn.addEventListener('click',exportSvg);els.pngBtn.addEventListener('click',exportPng);els.jsonBtn.addEventListener('click',exportJson);
  els.canvas.addEventListener('pointerdown',pointerDown);els.canvas.addEventListener('pointermove',pointerMove);els.canvas.addEventListener('pointerup',pointerUp);els.canvas.addEventListener('pointercancel',pointerUp);els.canvas.addEventListener('pointerleave',()=>{if(!state.painting){state.cursor=null;render();}});
  window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}});
  for(const ev of ['dragenter','dragover'])els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.add('dragover');});
  for(const ev of ['dragleave','drop'])els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.remove('dragover');});
  els.dropZone.addEventListener('drop',e=>loadFile(e.dataTransfer.files?.[0]));els.canvasWrap.addEventListener('dragover',e=>{e.preventDefault();els.canvasWrap.classList.add('dragover');});els.canvasWrap.addEventListener('dragleave',()=>els.canvasWrap.classList.remove('dragover'));els.canvasWrap.addEventListener('drop',e=>{e.preventDefault();els.canvasWrap.classList.remove('dragover');loadFile(e.dataTransfer.files?.[0]);});
  $('brushSizeText').value='10 mm';
})();
