import { editRevision, type JobRevisionPayload, type RevisionEdit } from './model.ts';

/** Scoped adapter for the EXISTING estimate/measurement editors. Never falls back to live fetch. */
export function createRevisionTransport(read:()=>JobRevisionPayload, apply:(edit:RevisionEdit)=>ReturnType<typeof editRevision>, readOnly=false) {
  return async (input: RequestInfo | URL, init?:RequestInit):Promise<Response> => {
    try {
      if(typeof input!=='string')throw new Error('Unsupported revision request.');
      const path=input.split('?')[0], method=init?.method??'GET', p=read();
      if(method==='GET') {
        if(path===`/api/projects/${p.project_id}/items`)return Response.json({items:p.items});
        if(path==='/api/contacts')return Response.json({contacts:[]});
        if(/^\/api\/contacts\/[^/]+$/.test(path))return Response.json({contact:null});
        throw new Error('Live project reads are unavailable inside this revision.');
      }
      if(readOnly)throw new Error('Frozen version is read-only.');
      const values=init?.body ? JSON.parse(String(init.body)):{};
      const action=method==='POST'?'add':method==='PATCH'?'patch':method==='DELETE'?'delete':null;
      if(!action)throw new Error('Unsupported revision method.');
      let edit:RevisionEdit|undefined, responseKey:string|undefined;
      let m:RegExpMatchArray|null;
      if(path===`/api/projects/${p.project_id}/estimate/markup`)edit={entity:'markup',action,values};
      else if(path===`/api/projects/${p.project_id}/estimate/sections`)edit={entity:'sections',action,values};
      else if((m=path.match(/^\/api\/estimate\/sections\/([^/]+)\/lines\/reorder$/)))edit={entity:'lines',action:'reorder',parent_id:m[1],ids:values.line_ids};
      else if((m=path.match(/^\/api\/estimate\/sections\/([^/]+)\/lines$/))){edit={entity:'lines',action,parent_id:m[1],values};responseKey='line';}
      else if((m=path.match(/^\/api\/estimate\/sections\/([^/]+)$/)))edit={entity:'sections',action,id:m[1],values};
      else if((m=path.match(/^\/api\/estimate\/lines\/([^/]+)$/))){edit={entity:'lines',action,id:m[1],values};responseKey='line';}
      else if(path===`/api/projects/${p.project_id}/estimate/measurements/groups`)edit={entity:'measurement_groups',action,values};
      else if((m=path.match(/^\/api\/estimate\/measurements\/groups\/([^/]+)\/measurements$/))){edit={entity:'measurements',action,parent_id:m[1],values};responseKey='measurement';}
      else if((m=path.match(/^\/api\/estimate\/measurements\/groups\/([^/]+)$/)))edit={entity:'measurement_groups',action,id:m[1],values};
      else if((m=path.match(/^\/api\/estimate\/measurements\/([^/]+)$/))){edit={entity:'measurements',action,id:m[1],values};responseKey='measurement';}
      if(!edit)throw new Error('This action is unavailable in a working revision. Accounting stays project-wide.');
      const result=apply(edit);
      return Response.json(responseKey?{[responseKey]:result.row}:{ok:true});
    } catch(error) {return Response.json({error:error instanceof Error?error.message:'Revision edit failed.'},{status:409});}
  };
}
