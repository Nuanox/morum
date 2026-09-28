/** Faithful JavaScript port of knowledge.normalize_quote / knowledge.quote_check
 * (supabase/migrations/202609200110_read_surfaces.sql). Used by
 * scripts/archive-check.mjs to compare a quote against archived page text
 * with exactly the same rule the database applies to a self-submitted
 * excerpt (supabase/functions and the SQL functions are the source of
 * truth; keep this in sync if either changes).
 *
 * knowledge.trim_text strips ASCII whitespace plus a specific set of
 * Unicode space/line separators (see the SQL for the exact code points).
 */
const TRIM_CHARS=[
 0x09,0x0a,0x0d,0x0c,0x0b,0x20,0xa0,0x1680,
 0x2000,0x2001,0x2002,0x2003,0x2004,0x2005,0x2006,0x2007,0x2008,0x2009,0x200a,
 0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,
].map(c=>String.fromCodePoint(c));
const TRIM_SET=new Set(TRIM_CHARS);

/** Port of knowledge.trim_text: btrim on the code points above. */
export function trimText(t){
 if(t===null||t===undefined)return t;
 const chars=Array.from(String(t));
 let start=0,end=chars.length;
 while(start<end&&TRIM_SET.has(chars[start]))start++;
 while(end>start&&TRIM_SET.has(chars[end-1]))end--;
 return chars.slice(start,end).join('');
}

/** Port of knowledge.normalize_quote: NFKC, strip zero-width chars, curly
 * quotes/dashes to straight ASCII, collapse whitespace (incl. NBSP), trim. */
export function normalizeQuote(t){
 let s=String(t).normalize('NFKC');
 // U+200B ZERO WIDTH SPACE .. U+200D ZERO WIDTH JOINER, U+FEFF ZERO WIDTH NO-BREAK SPACE
 s=s.replace(/[​-‍﻿]/g,'');
 // curly single quotes -> '
 s=s.replace(/[‘’]/g,"'");
 // curly double quotes -> "
 s=s.replace(/[“”]/g,'"');
 // en dash, em dash, figure dash -> -
 s=s.replace(/[–‒—]/g,'-');
 // collapse runs of whitespace (incl NBSP U+00A0) to a single space
 s=s.replace(/[\s ]+/g,' ');
 return s.trim();
}

/** Port of knowledge.quote_check(quote,submitted) -> one of the six states
 * the SQL function returns (never 'not_applicable', which only applies to
 * internal evidence). */
export function quoteCheck(quote,submitted){
 if(quote===null||quote===undefined||trimText(quote).length===0)return 'no_quote';
 if(submitted===null||submitted===undefined||trimText(submitted).length===0)return 'no_text';
 if(submitted.indexOf(quote)>=0)return 'found_exact';
 const nq=normalizeQuote(quote);
 const ns=normalizeQuote(submitted);
 if(ns.indexOf(nq)>=0)return 'found_normalized';
 // Split on an ellipsis: U+2026 or three literal dots.
 const frags=nq.split(/…|\.\.\./);
 if(frags.length>=2){
  let lastPos=0;
  let ok=true;
  for(const raw of frags){
   const frag=raw.trim();
   if(frag.length>=4){
    const idx=ns.indexOf(frag,lastPos);
    if(idx<0){ok=false;break;}
    lastPos=idx+frag.length;
   }
  }
  if(ok)return 'found_fragments';
 }
 return 'not_found';
}
