import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const source = readFileSync(new URL("./public/setup-wizard.mjs", import.meta.url), "utf8").replace("export async function initWizard", "async function initWizard");
const response = (json, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json,
  headers: new Headers({ "x-bootstrap-expires-at": new Date(Date.now() + 900000).toISOString() }) });
function harness(fetch) {
  const nodes = new Map(), storage = new Map(), replaced = [], listeners = {};
  const element = () => ({ hidden: true, textContent: "", className: "", innerHTML: "", value: "", disabled: false,
    dataset: {}, listeners: {}, elements: {}, append() {}, focus() {}, insertAdjacentHTML() {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    querySelector(selector) { return node(selector === 'button[type="submit"]' ? "#submit" : "#next-div"); } });
  const node = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const fields = { workspace_name: "QA Workspace", app_name: "QA App", owner_name: "QA", owner_email: "qa@example.test", owner_password: "password-not-stored", timezone: "UTC" };
  for (const [key,value] of Object.entries(fields)) node("#owner-form").elements[key] = {value};
  const context = vm.createContext({ document: {querySelector: node, createElement: element}, location: {hash:"#token=synthetic-installation-code-00000000",pathname:"/setup",search:""},
    history: {replaceState: (...args) => replaced.push(args)}, Headers, fetch, crypto: {randomUUID:()=>"request-key"},
    sessionStorage: {getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    FormData: class { constructor(form) { this.form=form; } *[Symbol.iterator]() { for (const [k,v] of Object.entries(this.form.elements)) yield [k,v.value]; } },
    setInterval:()=>1, clearInterval(){}, addEventListener:(event,fn)=>{listeners[event]=fn;}, Intl, Date });
  vm.runInContext(source, context);
  return {context,node,storage,replaced,listeners};
}
const state = (s="unclaimed") => ({mode:"single_tenant",state:s,setup_token_configured:true});
test("removes setup token before any readiness or bootstrap request", () => {
  const h=harness(()=>{throw new Error("should not fetch at import");});
  assert.equal(h.replaced[0][2],"/setup");
});
test("also removes tokens on fragment-only navigation in an already open setup tab", () => {
  const h=harness(()=>{throw new Error("claim is hidden");});
  h.context.location.hash="#token=another-synthetic-installation-code";
  h.listeners.hashchange();
  assert.equal(h.replaced.length,2);assert.equal(h.replaced[1][2],"/setup");
});
test("bootstrap status network failure remains retryable and does not pretend to be multi-tenant", async () => {
  const h=harness(async()=>{throw new Error("offline");});
  await assert.rejects(h.context.initWizard(),/Bootstrap status unavailable/);
  assert.match(h.node("#install-state-note").textContent,/다시 확인/);
  assert.equal(h.node("#claim").hidden,true);
});
test("claimed cookie holder resumes its draft without reclaiming or restoring a password", async () => {
  const paths=[];const h=harness(async(url)=>{paths.push(url);return url.endsWith('/status')?response(state("claimed")):response(null,204);});
  h.storage.set("nudgeon.setup.draft",JSON.stringify({workspace_name:"Recovered"}));
  await h.context.initWizard();
  assert.equal(h.node("#owner").hidden,false);assert.equal(h.node("#owner-form").elements.workspace_name.value,"Recovered");
  assert.deepEqual(paths,["/api/v1/bootstrap/status","/api/v1/bootstrap/extend"]);
});
test("lost setup response reads the existing result with the same idempotency key", async () => {
  const calls=[];const h=harness(async(url,options)=>{calls.push([url,options]);if(url.endsWith('/setup'))throw new Error("lost response");return response({tenant_id:"tenant",app_id:"app"});});
  await h.context.setup(h.node("#owner-form"));
  assert.equal(calls[0][1].headers["Idempotency-Key"],calls[1][1].headers["Idempotency-Key"]);
  assert.equal(calls[1][0],"/api/v1/bootstrap/setup-result");assert.equal(h.node("#secured").hidden,false);
  assert.equal(h.node("#next-step").dataset.secured,"true");
});
test("two network failures leave a visible recovery message and never store the password", async () => {
  const h=harness(async()=>{throw new Error("offline");});
  await h.context.setup(h.node("#owner-form"));
  assert.match(h.node("#owner-result").textContent,/연결 복구/);
  assert.equal(JSON.parse(h.storage.get("nudgeon.setup.draft")).owner_password,undefined);
  assert.equal(h.node("#secured").hidden,true);
});
test("a secured reload recovers with the stored key rather than creating another owner", async () => {
  const paths=[];const h=harness(async(url)=>{paths.push(url);return response(url.endsWith('/status')?state("secured"):{tenant_id:"tenant",app_id:"app"});});
  h.storage.set("nudgeon.setup.idempotency_key","existing-key");await h.context.initWizard();
  assert.equal(h.node("#secured").hidden,false);assert.deepEqual(paths,["/api/v1/bootstrap/status","/api/v1/bootstrap/setup-result"]);
});
