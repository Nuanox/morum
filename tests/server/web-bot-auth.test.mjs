import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign as cryptoSign} from 'node:crypto';
import {verifyWebBotAuth,jwkThumbprint,signatureBase,tryParseDictionary,clearDirectoryCache} from '../../.test-build/server/service/web-bot-auth.js';

// DEVIATION from the spec file's suggested path (tests/unit/web-bot-auth.test.mjs): the module
// under test imports 'server-only' and is only compiled by tsconfig.server.json / run through
// tests/helpers/register-server-only.mjs (see tests/server/adapter.test.mjs for the same
// pattern); `npm run test:unit` compiles just src/contracts + src/domain and has no
// 'server-only' stub, so it cannot load this file. It lives under tests/server/ instead and
// runs as part of `npm run test:server` (included in `npm run test:functional`).

function req(url,headers){return new Request(url,{headers});}

test('structured-field dictionary parser: strings, tokens, byte sequences, params, inner list-free dict', () => {
 const d=tryParseDictionary('a=1, b=?1, c="hi \\"there\\"", d=:aGVsbG8=:, e=token1;foo="bar"');
 assert.equal(d.get('a').value,1);
 assert.equal(d.get('b').value,true);
 assert.equal(d.get('c').value,'hi "there"');
 assert.deepEqual([...d.get('d').value],[...Buffer.from('hello')]);
 assert.equal(d.get('e').value.token,'token1');
 assert.equal(d.get('e').params.get('foo'),'bar');
 assert.equal(tryParseDictionary('not a dict = ='),undefined);
});

// --- RFC 9421 Appendix B.1.4 Ed25519 test key, reused by draft-ietf-webbotauth-httpsig-protocol-00
// Appendix E.2.1 (fetched 2026-09-28 from
// https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html).
const E21_JWK={kty:'OKP',crv:'Ed25519',x:'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',use:'sig'};
const E21_KEYID='poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U';
const E21_SIGNATURE_INPUT='sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"';
const E21_SIGNATURE='sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:';
const E21_AGENT='agent2="https://signature-agent.test"';
const E21_MAX_VALIDITY_SECONDS=4889289600-1735689600; // the draft's own illustrative (unrealistic) window

function e21Request(){
 // The draft signs "example.com" as @authority; the request URL's host must match that exactly
 // for @authority derivation, so the request is built against https://example.com/.
 return req('https://example.com/',{
  'signature-agent':E21_AGENT,
  'signature-input':E21_SIGNATURE_INPUT,
  'signature':E21_SIGNATURE,
 });
}

test('Appendix E.2.1 Ed25519 vector verifies against the draft example JWKS', async () => {
 clearDirectoryCache();
 const result=await verifyWebBotAuth(e21Request(),{
  now:1735689601,maxValiditySeconds:E21_MAX_VALIDITY_SECONDS,
  fetchDirectory:async (origin)=>{assert.equal(origin,'https://signature-agent.test');return {keys:[E21_JWK]};},
 });
 assert.equal(result.state,'verified');
 assert.equal(result.key_thumbprint,E21_KEYID);
 assert.equal(result.origin,'https://signature-agent.test');
});

test('thumbprint of the Appendix E.2.1 JWK matches its keyid', () => {
 assert.equal(jwkThumbprint(E21_JWK),E21_KEYID);
});

test('tampered signature is invalid', async () => {
 clearDirectoryCache();
 const tampered=E21_SIGNATURE.replace('Rd','xx');
 const result=await verifyWebBotAuth(req('https://example.com/',{
  'signature-agent':E21_AGENT,'signature-input':E21_SIGNATURE_INPUT,'signature':`sig2=:${tampered.split(':')[1]}:`,
 }),{now:1735689601,fetchDirectory:async ()=>({keys:[E21_JWK]})});
 assert.equal(result.state,'invalid');
});

test('expired signature is invalid', async () => {
 const result=await verifyWebBotAuth(e21Request(),{now:5000000000,fetchDirectory:async ()=>({keys:[E21_JWK]})});
 assert.deepEqual(result,{state:'invalid',reason:'expired'});
});

test('wrong tag is treated as absent a web-bot-auth signature (invalid)', async () => {
 const untagged=E21_SIGNATURE_INPUT.replace('tag="web-bot-auth"','tag="other"');
 const result=await verifyWebBotAuth(req('https://example.com/',{
  'signature-agent':E21_AGENT,'signature-input':untagged,'signature':E21_SIGNATURE,
 }),{now:1735689601,fetchDirectory:async ()=>({keys:[E21_JWK]})});
 assert.equal(result.state,'invalid');
 assert.equal(result.reason,'no_web_bot_auth_signature');
});

test('missing @authority and @target-uri is invalid', async () => {
 const noAuthority='sig2=("signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;tag="web-bot-auth"';
 const result=await verifyWebBotAuth(req('https://example.com/',{
  'signature-agent':E21_AGENT,'signature-input':noAuthority,'signature':E21_SIGNATURE,
 }),{now:1735689601,maxValiditySeconds:E21_MAX_VALIDITY_SECONDS,fetchDirectory:async ()=>({keys:[E21_JWK]})});
 assert.equal(result.state,'invalid');
 assert.equal(result.reason,'missing_authority_or_target_uri');
});

test('keyid/thumbprint mismatch is invalid', async () => {
 const result=await verifyWebBotAuth(e21Request(),{now:1735689601,maxValiditySeconds:E21_MAX_VALIDITY_SECONDS,fetchDirectory:async ()=>({keys:[{...E21_JWK,x:'A'.repeat(43)}]})});
 assert.equal(result.state,'invalid');
 assert.equal(result.reason,'key_not_found');
});

test('no signature headers at all is absent, never invalid', async () => {
 const result=await verifyWebBotAuth(req('https://example.com/',{}));
 assert.deepEqual(result,{state:'absent'});
});

// --- Fresh, self-generated Ed25519 keypair: sign a synthetic request end-to-end -----------------
test('fresh Ed25519 keypair signs and verifies a synthetic request end-to-end', async () => {
 clearDirectoryCache();
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const jwk=publicKey.export({format:'jwk'});
 const keyid=jwkThumbprint(jwk);
 const now=1700000000,created=now-5,expires=now+300;
 const coveredInput=`sig1=("@authority" "@target-uri");created=${created};keyid="${keyid}";alg="ed25519";expires=${expires};tag="web-bot-auth"`;
 const request=req('https://writer.example/api/v2/reviews',{
  'signature-agent':'a="https://writer.example"',
  'signature-input':coveredInput,
 });
 // Parse back the just-built Signature-Input to reuse signatureBase() exactly as the verifier will.
 const dict=tryParseDictionary(coveredInput);
 const base=signatureBase(request,new URL(request.url),dict.get('sig1'));
 const sig=cryptoSign(null,Buffer.from(base,'utf8'),privateKey);
 const finalRequest=req('https://writer.example/api/v2/reviews',{
  'signature-agent':'a="https://writer.example"',
  'signature-input':coveredInput,
  'signature':`sig1=:${sig.toString('base64')}:`,
 });
 const result=await verifyWebBotAuth(finalRequest,{
  now,
  fetchDirectory:async (origin)=>{assert.equal(origin,'https://writer.example');return {keys:[jwk]};},
 });
 assert.equal(result.state,'verified');
 assert.equal(result.key_thumbprint,keyid);
 assert.equal(result.origin,'https://writer.example');
});

test('directory unavailable is invalid, not absent, and never throws', async () => {
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const jwk=publicKey.export({format:'jwk'});
 const keyid=jwkThumbprint(jwk);
 const now=1700000000;
 const coveredInput=`sig1=("@authority");created=${now-1};keyid="${keyid}";alg="ed25519";expires=${now+300};tag="web-bot-auth"`;
 const dict=tryParseDictionary(coveredInput);
 const request=req('https://writer.example/x',{'signature-agent':'a="https://writer.example"','signature-input':coveredInput});
 const base=signatureBase(request,new URL(request.url),dict.get('sig1'));
 const sig=cryptoSign(null,Buffer.from(base,'utf8'),privateKey);
 const finalRequest=req('https://writer.example/x',{
  'signature-agent':'a="https://writer.example"','signature-input':coveredInput,'signature':`sig1=:${sig.toString('base64')}:`,
 });
 const result=await verifyWebBotAuth(finalRequest,{now,fetchDirectory:async ()=>null});
 assert.equal(result.state,'invalid');
 assert.equal(result.reason,'directory_unavailable');
});
