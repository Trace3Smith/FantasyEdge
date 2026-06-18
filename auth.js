// Shared auth + paywall bootstrap for every FantasyEdge page (no build step).
// Loads Clerk (vanilla JS), renders sign-in / user-button UI into the sidebar,
// wires the "Get Pro" upsell to a pricing modal -> Stripe Checkout, and exposes
// window.FE for the draft pages to make authenticated API calls.
//
// Subscription state is read from clerk.user.publicMetadata.plan (mirrored from
// Stripe by the webhook). The frontend gating here is cosmetic — every premium
// API endpoint re-verifies server-side.

const CLERK_CDN = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/+esm';
const GOLD = 'var(--gold, #D4A017)';

let clerk = null;

// --- styles (theme-matched, works across all pages' :root vars) ---------------
function injectStyles() {
  const css = `
  .fe-auth { padding: 14px 20px; border-bottom: 1px solid rgba(212,160,23,0.15); }
  .fe-auth .fe-signin {
    width: 100%; padding: 9px; border: 1px solid ${GOLD}; background: transparent;
    color: ${GOLD}; font-family: inherit; font-weight: 600; font-size: 13px;
    letter-spacing: .5px; border-radius: 6px; cursor: pointer; text-align: center;
  }
  .fe-auth .fe-signin:hover { background: rgba(212,160,23,0.12); }
  .fe-auth .fe-user { display: flex; align-items: center; gap: 10px; }
  .fe-badge {
    display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 1px;
    padding: 2px 7px; border-radius: 10px; text-transform: uppercase;
  }
  .fe-badge.premium { background: ${GOLD}; color: #111; }
  .fe-badge.free { background: rgba(255,255,255,0.08); color: #aaa; }

  .fe-modal-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 9999;
    display: none; align-items: center; justify-content: center; padding: 20px;
  }
  .fe-modal-bg.open { display: flex; }
  .fe-modal {
    background: var(--dark2, #1A1A1A); border: 1px solid rgba(212,160,23,0.25);
    border-radius: 14px; max-width: 720px; width: 100%; padding: 32px;
    font-family: inherit; color: var(--white, #F5F5F0); position: relative;
  }
  .fe-modal h2 { font-size: 26px; margin-bottom: 6px; }
  .fe-modal .fe-sub { color: #aaa; margin-bottom: 24px; font-size: 14px; }
  .fe-close { position: absolute; top: 16px; right: 18px; background: none; border: none;
    color: #888; font-size: 24px; cursor: pointer; line-height: 1; }
  .fe-plans { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 560px) { .fe-plans { grid-template-columns: 1fr; } }
  .fe-plan {
    border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 22px;
    display: flex; flex-direction: column; gap: 4px; position: relative;
  }
  .fe-plan.best { border-color: ${GOLD}; box-shadow: 0 0 0 1px ${GOLD} inset; }
  .fe-plan .fe-plan-name { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: #aaa; }
  .fe-plan .fe-price { font-size: 34px; font-weight: 700; }
  .fe-plan .fe-price span { font-size: 14px; color: #888; font-weight: 400; }
  .fe-plan .fe-save { color: ${GOLD}; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
  .fe-plan .fe-pick {
    margin-top: auto; padding: 11px; border-radius: 8px; border: none; cursor: pointer;
    font-family: inherit; font-weight: 700; font-size: 14px; background: rgba(255,255,255,0.1);
    color: var(--white, #fff);
  }
  .fe-plan.best .fe-pick { background: ${GOLD}; color: #111; }
  .fe-plan .fe-pick:disabled { opacity: .5; cursor: default; }
  .fe-tag-best {
    position: absolute; top: -10px; right: 16px; background: ${GOLD}; color: #111;
    font-size: 10px; font-weight: 700; letter-spacing: 1px; padding: 3px 9px; border-radius: 10px;
  }
  .fe-perks { list-style: none; margin: 18px 0 0; padding: 0; color: #bbb; font-size: 13px; }
  .fe-perks li { padding: 4px 0 4px 22px; position: relative; }
  .fe-perks li:before { content: '✓'; position: absolute; left: 0; color: ${GOLD}; font-weight: 700; }
  body:not(.is-premium) .premium-only { display: none !important; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

// --- authenticated fetch helpers ----------------------------------------------
async function authHeaders() {
  const token = clerk?.session ? await clerk.session.getToken() : null;
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function apiPost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

const isPremium = () => clerk?.user?.publicMetadata?.plan === 'premium';

// --- pricing modal -------------------------------------------------------------
function buildPricingModal() {
  const bg = document.createElement('div');
  bg.className = 'fe-modal-bg';
  bg.innerHTML = `
    <div class="fe-modal">
      <button class="fe-close" aria-label="Close">&times;</button>
      <h2>Go Premium</h2>
      <div class="fe-sub">Unlimited mock drafts, full-draft assistant, real draft mode &amp; custom league settings.</div>
      <div class="fe-plans">
        <div class="fe-plan">
          <div class="fe-plan-name">Monthly</div>
          <div class="fe-price">$9.99 <span>/ mo</span></div>
          <div class="fe-save">&nbsp;</div>
          <button class="fe-pick" data-interval="month">Choose Monthly</button>
        </div>
        <div class="fe-plan best">
          <span class="fe-tag-best">BEST VALUE</span>
          <div class="fe-plan-name">Annual</div>
          <div class="fe-price">$79 <span>/ yr</span></div>
          <div class="fe-save">Save ~34% · 2 months free</div>
          <button class="fe-pick" data-interval="year">Choose Annual</button>
        </div>
      </div>
      <ul class="fe-perks">
        <li>Unlimited mock drafts (free tier: 1 per day)</li>
        <li>Draft assistant for all rounds (free: rounds 1–7)</li>
        <li>Real draft mode with saved league settings</li>
      </ul>
    </div>`;
  document.body.appendChild(bg);

  const close = () => bg.classList.remove('open');
  bg.querySelector('.fe-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  bg.querySelectorAll('.fe-pick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!clerk?.user) { close(); clerk.openSignIn(); return; }
      btn.disabled = true;
      btn.textContent = 'Redirecting…';
      const { ok, data } = await apiPost('/api/stripe/checkout', { interval: btn.dataset.interval });
      if (ok && data?.url) { window.location.href = data.url; }
      else { btn.disabled = false; btn.textContent = 'Try again'; }
    });
  });
  return bg;
}

function openPricing() {
  if (!clerk?.user) { clerk.openSignIn(); return; }
  document.querySelector('.fe-modal-bg')?.classList.add('open');
}

// --- sidebar UI: auth slot + draft nav links ----------------------------------
function renderSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  // Auth slot just under the logo.
  let slot = sidebar.querySelector('.fe-auth');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'fe-auth';
    const logo = sidebar.querySelector('.sidebar-logo');
    if (logo && logo.nextSibling) sidebar.insertBefore(slot, logo.nextSibling);
    else sidebar.prepend(slot);
  }
  slot.innerHTML = '';
  if (clerk?.user) {
    const wrap = document.createElement('div');
    wrap.className = 'fe-user';
    const btn = document.createElement('div');
    wrap.appendChild(btn);
    const badge = document.createElement('span');
    badge.className = 'fe-badge ' + (isPremium() ? 'premium' : 'free');
    badge.textContent = isPremium() ? 'Premium' : 'Free';
    wrap.appendChild(badge);
    slot.appendChild(wrap);
    clerk.mountUserButton(btn, { afterSignOutUrl: window.location.href });
  } else {
    const b = document.createElement('button');
    b.className = 'fe-signin';
    b.textContent = 'Sign in';
    b.addEventListener('click', () => clerk.openSignIn());
    slot.appendChild(b);
  }
  // Draft nav links are defined statically in each page's sidebar (Draft Assistant +
  // Mock Draft), so we no longer inject them here — that caused a duplicate Mock Draft
  // and a stale Real Draft (?mode=real) link.
}

// Update the existing "Get Pro" box to the real price + premium-aware action.
function wireUpgradeButton(modal) {
  document.querySelectorAll('.upgrade-btn').forEach((btn) => {
    if (isPremium()) {
      btn.textContent = 'Manage plan';
      btn.onclick = async (e) => {
        e.preventDefault();
        const { ok, data } = await apiPost('/api/stripe/portal', {});
        if (ok && data?.url) window.location.href = data.url;
      };
    } else {
      btn.textContent = 'Get Pro — $9.99/mo';
      btn.onclick = (e) => { e.preventDefault(); openPricing(); };
    }
  });
}

function applyState(modal) {
  document.body.classList.toggle('is-premium', isPremium());
  renderSidebar();
  wireUpgradeButton(modal);
}

async function boot() {
  injectStyles();
  let cfg = {};
  try { cfg = await (await fetch('/api/public-config')).json(); } catch {}
  if (!cfg.clerkPublishableKey) {
    console.warn('[FE] No Clerk publishable key configured; auth disabled.');
    return;
  }
  const { Clerk } = await import(CLERK_CDN);
  clerk = new Clerk(cfg.clerkPublishableKey);
  await clerk.load();

  const modal = buildPricingModal();
  applyState(modal);
  // Re-render on auth/subscription changes (sign in/out, metadata refresh).
  clerk.addListener(() => applyState(modal));

  window.FE = {
    clerk,
    apiPost,
    getToken: () => (clerk.session ? clerk.session.getToken() : Promise.resolve(null)),
    isPremium,
    isSignedIn: () => !!clerk.user,
    openSignIn: () => clerk.openSignIn(),
    openPricing,
  };
  document.dispatchEvent(new CustomEvent('fe-auth-ready'));
}

boot();
