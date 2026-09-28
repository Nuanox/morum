/** Pure text extraction for scripts/archive-check.mjs: turns a fetched
 * HTML page into plain text comparable against a quote, without a DOM
 * parser (no new dependency). Drops <script>/<style>/<noscript>/<template>
 * (including their contents) and comments, replaces remaining tags with a
 * space, decodes the common HTML entities, and collapses whitespace. */

const DROP_TAGS=['script','style','noscript','template'];

export function extractHtmlText(html){
 let s=String(html);
 // Comments first, so a commented-out </script> etc. cannot confuse the tag scan below.
 s=s.replace(/<!--[\s\S]*?-->/g,' ');
 for(const tag of DROP_TAGS){
  const re=new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,'gi');
  s=s.replace(re,' ');
 }
 // Any remaining tag (including a stray unclosed drop-tag) becomes a space.
 s=s.replace(/<[^>]*>/g,' ');
 s=decodeEntities(s);
 s=s.replace(/\s+/g,' ').trim();
 return s;
}

const NAMED_ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};

function decodeEntities(s){
 return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,(m,body)=>{
  if(body[0]==='#'){
   const isHex=body[1]==='x'||body[1]==='X';
   const code=parseInt(isHex?body.slice(2):body.slice(1),isHex?16:10);
   if(Number.isFinite(code)){
    try{return String.fromCodePoint(code);}catch{return m;}
   }
   return m;
  }
  const key=body.toLowerCase();
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES,key)?NAMED_ENTITIES[key]:m;
 });
}
