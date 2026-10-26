import test from 'node:test';
import assert from 'node:assert/strict';
import {installMediaChatUi} from '../src/features/media/chat-ui.js';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.style={};this.className='';this.classList={add:(c)=>{this.className+=' '+c},remove:()=>{}};}
 get isConnected(){return this.root===true||!!this.parent?.isConnected;}
 setAttribute(k,v){this.attrs[k]=v;}
 append(...nodes){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){for(const n of this.children)n.parent=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}}
 replaceWith(n){const p=this.parent;if(!p)return;const i=p.children.indexOf(this);n.remove();p.children[i]=n;n.parent=p;this.parent=null;}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 querySelectorAll(selector){return this.children.flatMap(n=>[...(selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):n.tagName===selector)?[n]:[],...n.querySelectorAll(selector)]);}
 addEventListener(event,fn){this.events[event]=fn;}
 set src(value){this.source=value;this.connectedWhenRequested=this.isConnected;}
 get src(){return this.source;}
}

test('completed images remove the spinner before preview loading, including preview failure',async t=>{
 const oldDocument=globalThis.document,oldFetch=globalThis.fetch;t.after(()=>{globalThis.document=oldDocument;globalThis.fetch=oldFetch});
 globalThis.document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
 const id='11111111-1111-4111-8111-111111111111';
 globalThis.fetch=async path=>({ok:true,json:async()=>path.endsWith('/result')?{preview_url:'/owned/image.png?inline=1',download_url:'/owned/image.png',expires_at:'2026-10-28'}:{state:'completed',quote:{width:832,height:480,operation:'image_edit'},artifact:{media_available:true}}});
 const node=new Element('article');node.root=true;const body=new Element('div');body.className='message-body';node.append(body);
 const ui=installMediaChatUi({detect:()=>null,cache:()=>{},activeConversation:()=> 'conversation',identity:()=> 'owner',scroll:()=>{}});
 ui.restore(node,{kind:'image',job_id:id},'conversation');await new Promise(resolve=>setImmediate(resolve));
 const media=body.querySelector('img'),card=body.querySelector('section');
 assert.ok(media?.isConnected,'preview must be attached even before its load event');
 assert.equal(media.connectedWhenRequested,true,'attach before assigning src');assert.equal(media.loading,'eager');
 assert.equal(card.attrs['aria-busy'],'false');assert.equal(body.querySelector('.media-chat-loader'),null);
 assert.equal(body.querySelector('strong').textContent,'Your image is ready');assert.ok(body.querySelector('a'));
 media.events.error();assert.equal(media.hidden,true);assert.equal(body.querySelector('strong').textContent,'Your media is saved');
 assert.ok(body.querySelector('.media-chat-reload'));assert.equal(body.querySelector('.media-chat-loader'),null);
 body.querySelector('.media-chat-reload').onclick();assert.equal(media.hidden,false);assert.match(media.src,/reload=/);
 media.events.load();assert.equal(body.querySelector('strong').textContent,'Your image is ready');
});
