/** Pure JS vectors for scripts/lib/quote-check.mjs, the port of knowledge.quote_check /
 * knowledge.normalize_quote (supabase/migrations/202609200110_read_surfaces.sql). The SAME
 * vectors are run through the real SQL function in tests/db/archive-check.integration.test.mjs
 * to assert the port agrees with the database on every one. No database, no network here. */
import test from 'node:test';import assert from 'node:assert/strict';
import {squashForCompare,stripTrailingPunctuation,quoteCheck,normalizeQuote,trimText} from '../../scripts/lib/quote-check.mjs';

export const VECTORS=[
 {name:'exact substring',quote:'the quick brown fox',submitted:'Once upon a time, the quick brown fox jumped.',expected:'found_exact'},
 {name:'identical strings',quote:'hello world',submitted:'hello world',expected:'found_exact'},
 {name:'no quote text',quote:'',submitted:'anything here',expected:'no_quote'},
 {name:'quote is only whitespace',quote:'   \t\n  ',submitted:'anything here',expected:'no_quote'},
 {name:'no submitted text',quote:'a real quote',submitted:'',expected:'no_text'},
 {name:'submitted is only whitespace',quote:'a real quote',submitted:'   ',expected:'no_text'},
 {name:'curly quotes normalize to straight',quote:"it’s a “test”",submitted:'Well, it\'s a "test" indeed.',expected:'found_normalized'},
 {name:'em/en dash normalizes to hyphen',quote:'pre—post',submitted:'a pre-post b',expected:'found_normalized'},
 {name:'zero-width and BOM characters stripped',quote:'seamless',submitted:'this is se​am‌less text',expected:'found_normalized'},
 {name:'collapsed whitespace (NBSP, multiple spaces)',quote:'two words',submitted:'two   words here',expected:'found_normalized'},
 {name:'NFKC normalization (fullwidth to ascii)',quote:'ABC',submitted:'xxＡＢＣyy',expected:'found_normalized'},
 {name:'ellipsis fragments in order, both >=4 chars',quote:'the quick brown fox ... jumped over the lazy dog',submitted:'Somewhere, the quick brown fox definitely jumped over the lazy dog eventually.',expected:'found_fragments'},
 {name:'unicode ellipsis character fragments',quote:'alpha bravo…charlie delta',submitted:'alpha bravo and then some charlie delta',expected:'found_fragments'},
 {name:'fragment shorter than 4 chars is skipped, not required',quote:'A very long fragment here ... ok ... another long fragment appears',submitted:'A very long fragment here, then another long fragment appears.',expected:'found_fragments'},
 {name:'fragments out of order fail',quote:'second part ... first part',submitted:'first part comes before second part',expected:'not_found'},
 {name:'nothing matches at all',quote:'completely absent phrase',submitted:'this text shares nothing with the quote',expected:'not_found'},
 {name:'fragment missing entirely fails',quote:'alpha bravo ... zzz not present anywhere',submitted:'alpha bravo charlie delta',expected:'not_found'},
];

test('quoteCheck vectors',()=>{
 for(const v of VECTORS)assert.equal(quoteCheck(v.quote,v.submitted),v.expected,`${v.name}: expected ${v.expected}`);
});

test('trimText strips ASCII and the documented Unicode space/line separators',()=>{
 assert.equal(trimText('  \t\nhello    '),'hello');
 assert.equal(trimText(''),'');
});

test('normalizeQuote is idempotent',()=>{
 for(const v of VECTORS){
  const once=normalizeQuote(v.quote||' ');
  assert.equal(normalizeQuote(once),once);
 }
});

test('archive_check/2: trailing terminal punctuation is ignored only when asked',()=>{
 const page='a very chilly -18°C (0°F) instead of the comfortable 15°C (59°F) that it is today.';
 const quote='a very chilly -18°C (0°F) instead of the comfortable 15°C (59°F).';
 assert.equal(quoteCheck(quote,page),'not_found');
 assert.equal(quoteCheck(quote,page,{trailingPunctuation:true}),'found_normalized');
 assert.equal(quoteCheck('completely different words.',page,{trailingPunctuation:true}),'not_found');
 assert.equal(stripTrailingPunctuation('end?!…"'),'end');
});

test('archive_check/3: whitespace and footnote markers do not hide a passage, only when asked',()=>{
 const page='면역계는 인체 의 면역계 는 병원체를[ 4 ] 인식하고 제거한다.';
 const quote='인체의 면역계는 병원체를 인식하고 제거한다.';
 assert.equal(quoteCheck(quote,page),'not_found');
 assert.equal(quoteCheck(quote,page,{squash:true}),'found_normalized');
 assert.equal(quoteCheck('전혀 다른 문장이다.',page,{squash:true}),'not_found');
 assert.equal(squashForCompare('a b[12] c [ 3 ]d'),'abcd');
});
