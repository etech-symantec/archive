(function mainProgram(){
    "use strict";
    const $=id=>document.getElementById(id), fmt=n=>n.toLocaleString();
    const ROW=24, OVERSCAN=40, MAX_HEIGHT=8000000;
    let worker=null, file=null, loaded=false, revision=0, serial=0, primary=0, primaryKind="", searchJob=0, previewJob=0, previewReady=0;
    let active="all", info=null, total=0, counts={}, matches=new Uint32Array(0), matchIndex=0, searchTerm="", previewTimer=0;
    let keywords=["menlo","keyring"].map(text=>({text,color:color()})), applied=null, restore=false, notice="";
    const exportJobs=new Map();
    function color(){const colors=["#F38181","#6096B4","#8D7B68","#609966","#C06C84","#00A8CC","#AA96DA"];return colors[Math.floor(Math.random()*colors.length)];}
    function settings(){return {patterns:keywords.map(k=>k.text),ignoreCase:$("ignoreCase").checked};}
    function post(type,data={},id=++serial){worker.postMessage({type,id,revision,...data});return id;}
    function setNotice(message){notice=message;$("archiveJobText").textContent=message;refreshJobs();}
    function refreshJobs(){
        const busy=!!(primary||searchJob||previewJob||exportJobs.size);
        $("archiveJob").hidden=!busy&&!notice;
        $("archiveCancel").hidden=!busy;
        $("archiveProgress").hidden=!busy;
        if(!busy)$("archiveProgress").removeAttribute("value");
        $("copyBtn").disabled=!!primary||!loaded||!counts[active]?.kept||!!exportJobs.size;
        $("downloadBtn").disabled=$("copyBtn").disabled;
    }
    function createWorker(){
        if(worker)worker.terminate();
        for(const job of exportJobs.values())job.reject(new Error("작업 취소"));
        exportJobs.clear();
        worker=new Worker("archive-worker.js?v=20261127.03");
        const instance=worker;
        worker.onmessage=e=>{if(worker===instance)receive(e.data);};
        worker.onerror=e=>{if(worker!==instance)return;primary=searchJob=previewJob=0;loaded=false;setNotice("분석 엔진 오류: "+(e.message||"파일을 다시 열어 주세요."));updateTabs();};
    }
    function bounds(id){return id==="all"?{start:0,end:total}:info?.sections[id];}
    function updateTabs(){
        $("archiveTabs").hidden=!loaded;
        $("archiveTabs").querySelectorAll("[data-section]").forEach(b=>{
            const id=b.dataset.section;b.disabled=!bounds(id)||!!primary;
            b.setAttribute("aria-selected",String(active===id));b.tabIndex=active===id?0:-1;
            b.querySelector(".archive-tab-count").textContent=bounds(id)?fmt(counts[id]?.kept??0)+"줄":"없음";
        });
        const b=bounds(active);
        $("archiveStatus").hidden=!loaded;
        $("archiveStatus").textContent=(b&&b.end>b.start?"원본 "+fmt(b.start+1)+"–"+fmt(b.end)+"행":"빈 구간")+
            (info?.warnings?.length?"  ·  "+info.warnings.join(" / "):"");
        $("archiveStatus").classList.toggle("warning",!!info?.warnings?.length);
        refreshJobs();
    }
    class VirtualView{
        constructor(id,name,empty){
            this.el=$(id);this.name=name;this.empty=empty;this.count=0;this.request=0;this.frame=0;this.start=-1;this.end=-1;this.pendingStart=-1;this.pendingEnd=-1;this.rows=[];
            this.el.classList.add("virtual-view");
            this.el.addEventListener("scroll",()=>this.schedule(),{passive:true});
            if(typeof ResizeObserver!=="undefined")new ResizeObserver(()=>this.schedule(true)).observe(this.el);
        }
        setCount(count,message){
            this.count=count;this.request=++serial;this.start=this.end=this.pendingStart=this.pendingEnd=-1;this.rows=[];this.el.replaceChildren();
            this.el.scrollTop=0;this.el.scrollLeft=0;
            if(!count){const e=document.createElement("div");e.className="archive-empty";e.textContent=message||this.empty;this.el.append(e);this.space=null;return;}
            this.space=document.createElement("div");this.space.className="virtual-space";this.space.style.height=Math.min(MAX_HEIGHT,count*ROW)+"px";
            this.layer=document.createElement("div");this.layer.className="virtual-layer";this.space.append(this.layer);this.el.append(this.space);this.schedule(true);
        }
        metrics(){
            const vh=this.el.clientHeight||400, virtualMax=Math.max(0,this.count*ROW-vh), realMax=Math.max(0,Math.min(MAX_HEIGHT,this.count*ROW)-vh);
            const virtualTop=realMax?Math.min(virtualMax,Math.max(0,this.el.scrollTop)*virtualMax/realMax):0;
            return {vh,virtualMax,realMax,virtualTop};
        }
        schedule(force=false){
            if(!this.space||!this.count)return;
            if(force)this.start=this.end=-1;
            if(this.frame)return;
            this.frame=requestAnimationFrame(()=>{this.frame=0;this.refresh();});
        }
        refresh(){
            if(!this.space||!this.count||!loaded)return;
            const {vh,virtualTop}=this.metrics();
            const first=Math.min(this.count-1,Math.floor(virtualTop/ROW)),last=Math.min(this.count,first+Math.ceil(vh/ROW)+1);
            if(this.rows.length)this.place();
            if(this.start>=0&&this.start<=first&&this.end>=last)return;
            if(this.pendingStart>=0&&this.pendingStart<=first&&this.pendingEnd>=last)return;
            const start=Math.max(0,first-OVERSCAN),end=Math.min(this.count,Math.max(last+OVERSCAN,start+120),start+250);
            this.pendingStart=start;this.pendingEnd=end;
            this.request=post("window",{view:this.name,section:active,start,count:end-start,previewId:previewReady});
        }
        place(){
            if(!this.layer)return;
            const {virtualTop}=this.metrics();
            this.layer.style.top=(this.el.scrollTop+this.start*ROW-virtualTop)+"px";
        }
        receive(m){
            if(m.id!==this.request||!this.space)return;
            this.pendingStart=this.pendingEnd=-1;this.start=m.start;this.end=m.start+m.rows.length;this.rows=m.rows;
            this.draw();this.refresh();
        }
        draw(){
            if(!this.layer)return;
            const f=document.createDocumentFragment();
            this.rows.forEach(([number,line],i)=>{
                const row=document.createElement("div"),n=document.createElement("span"),t=document.createElement("span");
                row.className="virtual-row";n.className="virtual-number";t.className="virtual-text";n.textContent=number;t.textContent=line;
                if(this.name==="kept"&&searchTerm&&line.toLowerCase().includes(searchTerm.toLowerCase())){
                    row.classList.add("virtual-hit");if(matches[matchIndex]===this.start+i)row.classList.add("virtual-current");
                    const re=new RegExp("("+escapeRegExp(searchTerm)+")","gi");t.replaceChildren();
                    line.split(re).forEach((part,index)=>{if(index%2){const mark=document.createElement("mark");mark.className="content-search-highlight";mark.textContent=part;t.append(mark);}else t.append(document.createTextNode(part));});
                }
                row.append(n,t);f.append(row);
            });
            this.layer.replaceChildren(f);this.place();
        }
        go(index){
            if(!this.count)return;
            const {vh,virtualMax,realMax}=this.metrics(),top=Math.max(0,Math.min(virtualMax,index*ROW-(vh-ROW)/2));
            this.el.scrollTop=virtualMax?top*realMax/virtualMax:0;this.refresh();this.draw();
        }
    }
    const views={kept:new VirtualView("output","kept","표시할 내용이 없습니다."),removed:new VirtualView("removed","removed","삭제된 내용이 없습니다."),preview:new VirtualView("regexPreview","preview","일치하는 줄이 없습니다.")};
    function clearSearch(){
        searchJob=0;matches=new Uint32Array(0);matchIndex=0;searchTerm="";$("searchCount").style.display="none";document.querySelector(".search-nav").style.display="none";
    }
    function clearPreview(message="정규식을 입력하면 매칭 결과가 표시됩니다"){
        clearTimeout(previewTimer);previewJob=0;previewReady=0;$("matchCount").textContent="";views.preview.setCount(0,message);
    }
    function renderSection(runQueries=true){
        clearSearch();clearPreview();updateTabs();
        const c=counts[active]||{kept:0,removed:0};
        $("output").setAttribute("aria-labelledby","archive-tab-"+active);
        views.kept.setCount(c.kept);views.removed.setCount(c.removed);
        $("removedCount").textContent=" ("+fmt(c.removed)+"줄)";
        if(runQueries){if($("contentSearch").value.trim())searchContent(false);updateRegexPreview();}
    }
    function beginLoad(newFile,recover=false){
        file=newFile;loaded=false;revision=0;info=null;total=0;counts={};active=recover?active:"all";
        clearSearch();clearPreview();createWorker();restore=recover;
        if(!recover){applied=null;$("contentSearch").value="";}
        views.kept.setCount(0,"파일을 분석하고 있습니다…");views.removed.setCount(0,"분석 중…");
        primaryKind="load";primary=++serial;
        $("archiveProgress").removeAttribute("value");setNotice(recover?"작업 취소 후 이전 데이터 복구 중…":"파일 읽기 및 분석 중…");
        updateTabs();
        post("load",{file,...(recover&&applied?applied:settings())},primary);
    }
    function filterText(){
        if(!loaded||primary)return;
        const config=settings();
        try{config.patterns.forEach(p=>new RegExp(p,config.ignoreCase?"i":""));}catch(e){setNotice("정규식 오류: "+e.message);return;}
        clearSearch();clearPreview();primaryKind="filter";primary=++serial;
        $("archiveProgress").removeAttribute("value");setNotice("키워드 필터링 중…");updateTabs();post("filter",config,primary);
    }
    let pendingSettings=null;
    function receive(m){
        if(m.type==="progress"&&m.id===primary){
            const progress=$("archiveProgress");
            if(m.total){progress.max=m.total;progress.value=m.done;setNotice("키워드 필터링 "+fmt(m.done)+" / "+fmt(m.total)+"줄");}
            else{progress.removeAttribute("value");setNotice(m.job==="read"?"파일 읽는 중…":"구간 분리 중…");}
        }else if(m.type==="filtered"&&m.id===primary){
            revision=m.revision;info=m.info;total=m.total;counts=m.counts;loaded=true;primary=0;
            applied=pendingSettings||applied||settings();pendingSettings=null;
            if(!bounds(active))active="all";
            $("copyBtn").style.display=$("downloadBtn").style.display="inline-block";
            const wasRestore=restore;restore=false;setNotice(wasRestore?"이전 데이터 복구 완료":"분석 완료 · "+fmt(total)+"줄");
            renderSection(!wasRestore);
            if(!wasRestore&&applied.patterns.length && JSON.stringify(settings())!==JSON.stringify(applied))filterText();
        }else if(m.type==="window"&&m.revision===revision){views[m.view]?.receive(m);}
        else if(m.type==="searched"&&m.id===searchJob&&m.revision===revision){
            searchJob=0;matches=m.positions;matchIndex=0;updateSearchNavigation();views.kept.draw();
            if(searchJump&&matches.length)views.kept.go(matches[0]);setNotice("검색 완료 · "+fmt(matches.length)+"줄");
        }else if(m.type==="previewed"&&m.id===previewJob&&m.revision===revision){
            previewJob=0;previewReady=m.id;$("matchCount").textContent="총 "+fmt(m.count)+"줄";
            views.preview.setCount(m.count,"일치하는 줄이 없습니다.");setNotice("정규식 검사 완료 · "+fmt(m.count)+"줄");
        }else if(m.type==="exported"){
            const job=exportJobs.get(m.id);if(job){exportJobs.delete(m.id);job.resolve(m.blob);refreshJobs();}
        }else if(m.type==="error"){
            if(m.id===primary){
                primary=0;pendingSettings=null;
                if(!loaded&&m.job==="filter"){
                    primary=++serial;primaryKind="load";pendingSettings={patterns:[],ignoreCase:false};
                    setNotice("잘못된 필터를 제외하고 원본을 표시합니다.");
                    post("filter",pendingSettings,primary);return;
                }
                updateTabs();
            }else if(m.id===searchJob){searchJob=0;updateSearchNavigation();}
            else if(m.id===previewJob){previewJob=0;views.preview.setCount(0,m.message);}
            else if(exportJobs.has(m.id)){const job=exportJobs.get(m.id);exportJobs.delete(m.id);job.reject(new Error(m.message));}
            else return;
            setNotice("오류: "+m.message);
        }
    }
    // Track the exact configuration sent, even if edited during a scan.
    const originalPost=post;
    function sendTracked(type,data,id){
        if(type==="load"||type==="filter")pendingSettings={patterns:[...data.patterns],ignoreCase:data.ignoreCase};
        return originalPost(type,data,id);
    }
    post=sendTracked;
    function cancelWork(){
        const canRestore=loaded&&applied&&file;
        primary=searchJob=previewJob=0;clearSearch();clearPreview();pendingSettings=null;
        if(canRestore){beginLoad(file,true);}
        else{worker?.terminate();worker=null;loaded=false;file=null;info=null;counts={};views.kept.setCount(0,"작업이 취소되었습니다. 파일을 다시 열어 주세요.");views.removed.setCount(0);updateTabs();setNotice("작업 취소");}
    }
    function selectArchiveSection(id){
        if(primary||!loaded||!bounds(id)||id===active)return;
        post("cancel",{job:"search"});post("cancel",{job:"preview"});active=id;renderSection();
    }
    let searchJump=true;
    function updateSearchNavigation(){
        const count=$("searchCount");count.style.display="inline-block";count.textContent=fmt(matches.length)+"개";
        document.querySelector(".search-nav").style.display=matches.length?"flex":"none";
        $("currentSearchPos").textContent=fmt(matchIndex+1)+"/"+fmt(matches.length);
    }
    function searchContent(jump=true){
        if(!loaded||primary)return;
        const term=$("contentSearch").value.trim();post("cancel",{job:"search"});clearSearch();views.kept.draw();
        if(!term){refreshJobs();return;}
        searchTerm=term;searchJump=jump;searchJob=++serial;$("searchCount").style.display="inline-block";$("searchCount").textContent="검색 중";
        setNotice("현재 탭 전체 내용 검색 중…");post("search",{section:active,term},searchJob);
    }
    function navigateSearch(direction){
        if(!matches.length)return;
        matchIndex=(matchIndex+direction+matches.length)%matches.length;updateSearchNavigation();views.kept.go(matches[matchIndex]);
    }
    function updateRegexPreview(){
        if(!loaded||primary)return;
        clearPreview();post("cancel",{job:"preview"});const term=$("keywordInput").value;
        if(!term){refreshJobs();return;}
        previewTimer=setTimeout(()=>{
            if(!loaded||primary)return;
            previewJob=++serial;views.preview.setCount(0,"정규식 검사 중…");$("matchCount").textContent="검사 중";
            setNotice("정규식 검사 중…");post("preview",{section:active,term,ignoreCase:$("ignoreCase").checked},previewJob);
        },180);
    }
    function persist(){try{localStorage.setItem("keywords",JSON.stringify(keywords));}catch(e){}}
    function renderKeywords(){
        $("keywordList").replaceChildren();
        keywords.forEach((kw,i)=>{
            const tag=document.createElement("span");tag.className="tag";tag.style.background=kw.color;tag.textContent=kw.text+" ×";
            tag.onclick=()=>{keywords.splice(i,1);persist();renderKeywords();filterText();};$("keywordList").append(tag);
        });
    }
    function addKeyword(){
        const input=$("keywordInput"),value=input.value.trim();if(!value)return;
        try{new RegExp(value);}catch(e){setNotice("정규식 오류: "+e.message);return;}
        keywords.push({text:value,color:color()});input.value="";persist();renderKeywords();filterText();
    }
    function escapeRegExp(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
    function addSearchToKeyword(){
        const input=$("contentSearch"),value=input.value.trim();if(!value)return;
        keywords.push({text:escapeRegExp(value),color:color()});input.value="";persist();renderKeywords();filterText();
    }
    function insertRegex(text){const i=$("keywordInput"),start=i.selectionStart,end=i.selectionEnd;i.setRangeText(text,start,end,"end");i.focus();updateRegexPreview();}
    function applyPattern(pattern){if(!pattern)return;$("keywordInput").value=pattern;$("keywordInput").focus();updateRegexPreview();document.querySelector(".pattern-select").value="";}
    function requestExport(){
        if(!loaded||primary||!counts[active]?.kept)return Promise.reject(new Error("내보낼 내용이 없습니다."));
        return new Promise((resolve,reject)=>{const id=++serial;exportJobs.set(id,{resolve,reject});setNotice("전체 탭 데이터 내보내는 중…");post("export",{section:active},id);});
    }
    async function downloadTxt(){
        const name=(file?.name||"archconf").replace(/\.[^/.]+$/,""),suffix=active==="all"?"":"_"+active,date=new Date().toISOString().slice(0,10).replace(/-/g,"");
        try{const blob=await requestExport(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name+suffix+"_edited_"+date+".txt";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);setNotice("다운로드 완료");}catch(e){setNotice(e.message);}
    }
    async function copyResult(){
        try{
            if(navigator.clipboard?.write&&typeof ClipboardItem!=="undefined"){
                const blob=requestExport();try{await navigator.clipboard.write([new ClipboardItem({"text/plain":blob})]);}catch(e){await navigator.clipboard.writeText(await (await blob).text());}
            }else{await navigator.clipboard.writeText(await (await requestExport()).text());}
            setNotice("선택한 탭 전체 내용 복사 완료");
        }catch(e){setNotice("복사 실패: "+e.message+" · 다운로드를 이용해 주세요.");}
    }
    Object.assign(window,{addKeyword,filterText,insertRegex,applyPattern,handleSearchKey:e=>{if(e.key==="Enter")searchContent();},searchContent,navigateSearch,addSearchToKeyword,copyResult,downloadTxt});
    $("archiveTabs").addEventListener("click",e=>{const b=e.target.closest("[data-section]");if(b&&!b.disabled)selectArchiveSection(b.dataset.section);});
    $("archiveTabs").addEventListener("keydown",e=>{
        if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;
        const buttons=Array.from(e.currentTarget.querySelectorAll("button:not(:disabled)"));if(!buttons.length)return;e.preventDefault();
        const i=buttons.findIndex(b=>b.dataset.section===active),next=e.key==="Home"?0:e.key==="End"?buttons.length-1:(i+(e.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
        selectArchiveSection(buttons[next].dataset.section);buttons[next].focus();
    });
    $("fileInput").addEventListener("change",e=>{const f=e.target.files[0];e.target.value="";if(f)beginLoad(f);});
    $("output").addEventListener("dragover",e=>{e.preventDefault();e.currentTarget.style.backgroundColor="#e3f2fd";});
    $("output").addEventListener("dragleave",e=>{e.currentTarget.style.backgroundColor="";});
    $("output").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.style.backgroundColor="";const f=e.dataTransfer.files[0];if(f)beginLoad(f);});
    $("archiveCancel").addEventListener("click",cancelWork);
    $("keywordInput").addEventListener("input",updateRegexPreview);
    $("keywordInput").addEventListener("keydown",e=>{if(e.key==="Enter")addKeyword();});
    $("ignoreCase").addEventListener("change",()=>{if(loaded&&!primary)filterText();});
    try{const saved=JSON.parse(localStorage.getItem("keywords"));if(Array.isArray(saved)&&saved.every(k=>typeof k.text==="string"))keywords=saved.map(k=>({text:k.text,color:k.color||color()}));}catch(e){}
    renderKeywords();clearPreview();refreshJobs();
})();
