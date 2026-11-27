function parseArchive(lines) {
    const definitions = [
        { id: "proxies", heading: /^\s*!-\s*BEGIN\s+proxies\s*$/i, inline: /^\s*inline\s+exceptions\s+(end-\d+-inline)\s*$/i },
        { id: "policy", heading: /^\s*!-\s*BEGIN\s+policy\s*$/i, inline: /^\s*inline\s+policy\s+local\s+(end-\d+-inline)\s*$/i }
    ];
    const starts = definitions.map(def => ({ ...def, start: lines.findIndex(line => def.heading.test(line)) }))
        .filter(def => def.start >= 0).sort((a,b) => a.start-b.start);
    const sections = {
        general: { start: 0, end: starts.length ? starts[0].start : lines.length },
        proxies: null, policy: null
    };
    const warnings = [];
    for (const def of definitions) {
        if (!starts.some(item => item.id === def.id)) warnings.push(def.id + " 시작 구간 없음");
    }
    starts.forEach((def, i) => {
        const end = i+1 < starts.length ? starts[i+1].start : lines.length;
        sections[def.id] = { start: def.start, end };
        const declaration = lines.slice(def.start+1,end).find(line => def.inline.test(line));
        if (!declaration) warnings.push(def.id + " inline 시작 문구 없음");
    });
    if(starts.length===2 && starts[0].id!=="proxies") warnings.push("proxies / policy 순서 확인 필요");
    return { sections, warnings };
}

(function workerMain(){
    "use strict";
    let lines=[], info=null, kept=new Uint32Array(0), removed=new Uint32Array(0), preview=new Uint32Array(0);
    let tasks={filter:0,search:0,preview:0}, revision=0, ready=false;
    const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
    const send=(type,id,data={},transfer=[])=>self.postMessage({type,id,...data},transfer);
    function lower(a,value){let l=0,r=a.length;while(l<r){const m=l+Math.floor((r-l)/2);if(a[m]<value)l=m+1;else r=m;}return l;}
    function range(a,section){const b=section==="all"?{start:0,end:lines.length}:info.sections[section];return b?[lower(a,b.start),lower(a,b.end)]:[0,0];}
    function counts(){const result={};for(const section of ["all","general","proxies","policy"]){const k=range(kept,section),r=range(removed,section);result[section]={kept:k[1]-k[0],removed:r[1]-r[0]};}return result;}
    async function filter(m){
        tasks.filter=m.id; tasks.search=0; tasks.preview=0;
        const valid=()=>tasks.filter===m.id;
        let patterns;
        try{patterns=m.patterns.map(p=>new RegExp(p,m.ignoreCase?"i":""));}
        catch(e){send("error",m.id,{job:"filter",message:"유효하지 않은 정규식: "+e.message});return;}
        const k=new Uint32Array(lines.length),r=new Uint32Array(lines.length);let ki=0,ri=0;
        for(let i=0;i<lines.length;i++){
            if(patterns.some(p=>p.test(lines[i])))r[ri++]=i;else k[ki++]=i;
            if((i+1)%16384===0){if((i+1)%65536===0)send("progress",m.id,{job:"filter",done:i+1,total:lines.length});await tick();if(!valid())return;}
        }
        if(!valid())return;
        kept=k.subarray(0,ki);removed=r.subarray(0,ri);preview=new Uint32Array(0);revision++;ready=true;
        send("filtered",m.id,{revision,info,total:lines.length,counts:counts()});
    }
    async function scan(m,kind){
        tasks[kind]=m.id; const rev=revision;
        const valid=()=>tasks[kind]===m.id&&revision===rev;
        let source,start,end,match;
        if(kind==="search"){
            source=kept;[start,end]=range(source,m.section);
            const term=m.term.toLowerCase();match=line=>line.toLowerCase().includes(term);
        }else{
            const b=m.section==="all"?{start:0,end:lines.length}:info.sections[m.section];
            start=b?.start??0;end=b?.end??0;
            try{const re=new RegExp(m.term,m.ignoreCase?"i":"");match=line=>re.test(line);}
            catch(e){send("error",m.id,{job:kind,message:"유효하지 않은 정규식입니다."});return;}
        }
        const result=new Uint32Array(end-start);let n=0;
        for(let i=start;i<end;i++){
            const lineIndex=source?source[i]:i;
            if(match(lines[lineIndex]))result[n++]=source?i-start:lineIndex;
            if((i-start+1)%16384===0){await tick();if(!valid())return;}
        }
        if(!valid())return;
        if(kind==="search"){const positions=result.subarray(0,n);send("searched",m.id,{positions,revision},[positions.buffer]);}
        else{preview=result.subarray(0,n);send("previewed",m.id,{count:n,revision});}
    }
    function windowRows(m){
        if(m.revision!==revision)return;
        const a=m.view==="preview"?preview:m.view==="removed"?removed:kept;
        if(m.view==="preview"&&m.previewId!==tasks.preview)return;
        const [lo,hi]=m.view==="preview"?[0,a.length]:range(a,m.section);
        const start=Math.max(0,Math.min(hi-lo,m.start)),end=Math.min(hi-lo,start+Math.min(250,Math.max(0,m.count)));
        const rows=[];
        for(let i=start;i<end;i++){const index=a[lo+i];rows.push([index+1,lines[index]]);}
        send("window",m.id,{view:m.view,start,rows,revision});
    }
    function exportRows(m){
        const [lo,hi]=range(kept,m.section);
        if(lo===hi){send("error",m.id,{job:"export",message:"내보낼 내용이 없습니다."});return;}
        const parts=[];
        for(let start=lo;start<hi;start+=8192){
            const end=Math.min(hi,start+8192),chunk=[];
            for(let i=start;i<end;i++)chunk.push(lines[kept[i]]);
            parts.push((start===lo?"":"\n")+chunk.join("\n"));
        }
        send("exported",m.id,{blob:new Blob(parts,{type:"text/plain"})});
    }
    self.onmessage=async event=>{
        const m=event.data;
        try{
            if(m.type==="load"){
                ready=false;send("progress",m.id,{job:"read",done:0,total:0});
                const text=await m.file.text();
                lines=text?text.replace(/^\uFEFF/,"").split(/\r\n|\n|\r/):[];
                send("progress",m.id,{job:"parse",done:0,total:0});
                info=parseArchive(lines);await filter(m);return;
            }
            if(m.type==="cancel"){tasks[m.job]=0;return;}
            if(!info)return;
            if(m.type==="filter"){await filter(m);return;}
            if(!ready||m.revision!==revision)return;
            if(m.type==="search"||m.type==="preview"){await scan(m,m.type);return;}
            if(m.type==="window"){windowRows(m);return;}
            if(m.type==="export"){exportRows(m);return;}
        }catch(e){send("error",m.id,{job:m.type,message:e.message||String(e)});}
    };
})();
