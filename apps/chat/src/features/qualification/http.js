import { createHash,timingSafeEqual } from 'node:crypto';
import { evaluateCoding } from './coding.js';
import { httpError } from '../../shared/http-error.js';
const digest=v=>createHash('sha256').update(String(v)).digest();
export function codingQualificationController({operatorToken,readJsonBody,sendJson}) {
  return async ({request,response,url})=>{
    if(url.pathname!=='/internal/qualification/coding')return false;
    if(request.method!=='POST')throw httpError(405,'POST required');
    if(!operatorToken||!timingSafeEqual(digest(String(request.headers.authorization??'').replace(/^Bearer /,'')),digest(operatorToken)))throw httpError(401,'Qualification dispatcher authorization required');
    const body=await readJsonBody(request);
    if(!body||typeof body.source!=='string'||body.source.length>16384||!['coding_medium','coding_large'].includes(body.level))throw httpError(400,'Invalid qualification source or suite');
    sendJson(response,200,evaluateCoding(body));return true;
  };
}
