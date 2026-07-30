const SERVER_TS={__s:'ts'}, DELETE={__s:'del'};
class Timestamp{
  constructor(ms){ this.ms=ms; }
  toMillis(){ return this.ms; }
  toDate(){ return new Date(this.ms); }
  static fromMillis(ms){ return new Timestamp(ms); }
  static now(){ return new Timestamp(Date.now()); }
}
const store=new Map();
let auto=0;
function apply(cur,data,merge){
  const b=merge?{...(cur||{})}:{};
  for(const[k,v]of Object.entries(data)){
    if(v===DELETE)delete b[k];
    else if(v===SERVER_TS)b[k]=Timestamp.now();
    else b[k]=v;
  }
  return b;
}
function snapOf(path){
  const e=store.has(path);
  const d=e?{...store.get(path)}:undefined;
  return{exists:e,id:path.split('/').pop(),ref:docRef(path),data:()=>d};
}
function docRef(path){
  return{path,id:path.split('/').pop(),
    collection:n=>colRef(path+'/'+n),
    async get(){return snapOf(path);},
    async set(d,o){store.set(path,apply(store.get(path),d,!!(o&&o.merge)));},
    async update(d){if(!store.has(path))throw new Error('NOT_FOUND '+path);store.set(path,apply(store.get(path),d,true));},
    async delete(){store.delete(path);}};
}
function cmp(v,op,val){
  const a=(v&&v.ms!==undefined)?v.ms:v, b=(val&&val.ms!==undefined)?val.ms:val;
  if(op==='==')return a===b;
  if(op==='in')return val.includes(v);
  if(op==='>')return a>b;
  if(op==='<')return a<b;
  if(op==='>=')return a>=b;
  if(op==='<=')return a<=b;
  return false;
}
function match(path,prefix,group){
  if(group){
    const parts=path.split('/');
    return parts.length>=2 && parts[parts.length-2]===prefix && !path.slice(0,-(parts.at(-1).length+1)).endsWith('//');
  }
  return path.startsWith(prefix+'/') && !path.slice(prefix.length+1).includes('/');
}
function colRef(prefix,group){
  const f=[]; let lim=Infinity, ord=null;
  const q={
    doc(id){ return docRef(prefix+'/'+(id||('auto'+(++auto)+Math.random().toString(36).slice(2,8)))); },
    async add(d){ const r=q.doc(); await r.set(d); return r; },
    where(a,op,v){ f.push([a,op,v]); return q; },
    orderBy(field,dir){ ord=[field,dir||'asc']; return q; },
    limit(n){ lim=n; return q; },
    async get(){
      let out=[];
      for(const[k,v]of store){
        if(!match(k,prefix,group))continue;
        if(f.every(([fl,op,val])=>cmp(v[fl],op,val)))out.push(snapOf(k));
      }
      if(ord){
        const[fl,dir]=ord;
        out.sort((x,y)=>{
          const a=x.data()[fl],b=y.data()[fl];
          const av=(a&&a.ms!==undefined)?a.ms:a, bv=(b&&b.ms!==undefined)?b.ms:b;
          return (av<bv?-1:av>bv?1:0)*(dir==='desc'?-1:1);
        });
      }
      out=out.slice(0,lim);
      return{empty:!out.length,size:out.length,docs:out,forEach:fn=>out.forEach(fn)};
    }
  };
  return q;
}
const firestore=()=>({
  collection:p=>colRef(p),
  collectionGroup:n=>colRef(n,true),
  doc:p=>docRef(p),
  batch(){
    const ops=[];
    return{
      set(r,d,o){ops.push(['s',r,d,o]);},
      update(r,d){ops.push(['u',r,d]);},
      delete(r){ops.push(['d',r]);},
      async commit(){for(const o of ops){
        if(o[0]==='s')store.set(o[1].path,apply(store.get(o[1].path),o[2],!!(o[3]&&o[3].merge)));
        else if(o[0]==='d')store.delete(o[1].path);
        else store.set(o[1].path,apply(store.get(o[1].path),o[2],true));}}
    };
  },
  async runTransaction(fn){
    for(let attempt=0;attempt<5;attempt++){
      const reads=new Map(); const writes=[];
      const snap=(r)=>{const s=snapOf(r.path);reads.set(r.path,JSON.stringify(s.exists?store.get(r.path):null));return s;};
      const tx={
        get:async r=>snap(r),
        getAll:async(...rs)=>rs.map(snap),
        set:(r,d,o)=>writes.push([r,d,!!(o&&o.merge)]),
        update:(r,d)=>{writes.push([r,d,true,true]);}
      };
      const res=await fn(tx);
      let conflict=false;
      for(const[p,seen]of reads){
        if(JSON.stringify(store.has(p)?store.get(p):null)!==seen){conflict=true;break;}
      }
      if(conflict)continue;
      for(const[r,d,m,req]of writes){
        if(req&&!store.has(r.path))throw new Error('NOT_FOUND '+r.path);
        store.set(r.path,apply(store.get(r.path),d,m));
      }
      return res;
    }
    throw new Error('txn retries exhausted');
  }
});
Object.assign(firestore,{Timestamp,FieldValue:{serverTimestamp:()=>SERVER_TS,delete:()=>DELETE}});
module.exports={initializeApp(){},firestore,__store:store,__Timestamp:Timestamp};
