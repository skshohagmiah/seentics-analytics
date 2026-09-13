import Link from 'next/link';
import { C, Callout, CodeBlock, DocPage, DocSection, Li, P, RefTable, Ul } from '@/components/docs/DocsKit';

export const metadata = {
  title: 'Tracker script · Seentics docs',
  description: 'Every Seentics script attribute and the browser API: track, identify, page and flush.',
};

/**
 * Every claim here is read off `public/trackers/seentics.js`.
 *
 * The page this replaces documented four attributes, of which one was misspelled
 * (`data-site-id` for `data-website-id`) and two did not exist at all (`data-debug`,
 * `data-mask-pii`), while the two that matter for self-hosting — `data-api-host` and
 * `data-rrweb-src` — were missing. The browser API was not documented anywhere.
 */
export default function TrackerPage() {
  return (
    <DocPage
      eyebrow="Integration"
      title="Tracker script"
      lead="One file, about 11 KB gzipped, covering analytics, funnels, heatmaps and automations."
    >
      <DocSection title="The tag">
        <CodeBlock
          filename="index.html"
          language="html"
          code={`<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  src="https://app.seentics.com/trackers/seentics.min.js"
></script>`}
        />
        <P>
          <C>defer</C> matters: the tracker reads its own <C>&lt;script&gt;</C> element to find its
          configuration, so it needs the tag to exist in the document.
        </P>
      </DocSection>

      <DocSection title="Script attributes">
        <P>
          Four attributes, and only the first is required. Anything not listed here is ignored — the
          tracker reads exactly these.
        </P>
        <RefTable
          columns={['Attribute', 'Default', 'What it does']}
          rows={[
            [
              <C>data-website-id</C>,
              <span className="text-muted-foreground/60">required</span>,
              'The website UUID from Settings → Tracking. Without it the tracker logs a console error and sends nothing.',
            ],
            [
              <C>data-api-host</C>,
              <span>the script&apos;s own origin</span>,
              <span>
                Where events are sent. Derived from the <C>src</C> origin when omitted, so a
                self-hosted install usually needs nothing. Set it when your API lives on a different
                host. A trailing <C>/api/v1</C> is stripped, so either form works.
              </span>,
            ],
            [
              <C>data-auto-track</C>,
              <C>true</C>,
              <span>
                Set to <C>&quot;false&quot;</C> to stop automatic pageviews and send them yourself with{' '}
                <C>seentics.page()</C>.
              </span>,
            ],
            [
              <C>data-rrweb-src</C>,
              <span>
                <C>seentics-dom.min.js</C> beside the tracker
              </span>,
              'Where to load the session recorder from. Only needed if you serve the two files from different places.',
            ],
            [
              <C>data-capture-console</C>,
              <C>on</C>,
              <span>
                Set to <C>&quot;off&quot;</C> to leave <C>console</C> untouched. On, recordings
                include console output (scrubbed for credentials); off, the override is never
                installed.
              </span>,
            ],
            [
              <C>data-capture-network</C>,
              <C>on</C>,
              <span>
                Set to <C>&quot;off&quot;</C> to leave <C>fetch</C> and <C>XMLHttpRequest</C>{' '}
                untouched. On, recordings include request method, URL, status and duration —
                never bodies.
              </span>,
            ],
          ]}
        />
        <Callout kind="warning" title="Two attributes that used to be documented do not exist">
          <C>data-debug</C> and <C>data-mask-pii</C> appeared in earlier versions of these docs and
          were never read by the tracker. There is no masking attribute because masking is not
          optional — see below.
        </Callout>
      </DocSection>

      <DocSection title="Browser API">
        <P>
          The tracker exposes four methods on <C>window.seentics</C>. They are safe to call as soon
          as the script has run.
        </P>
        <RefTable
          columns={['Method', 'What it does']}
          rows={[
            [
              <C>seentics.track(name, props?)</C>,
              'Records a custom event. Also evaluates any funnel step matching that event name, and fires automations with a Custom Event trigger — one call, three effects.',
            ],
            [
              <C>seentics.identify(userId, traits?)</C>,
              'Attaches your own user ID to this visitor. Stored against their profile, so it survives reloads and later sessions, and fires automations with an Identify trigger. The anonymous visitor ID is left as it is, so calling this does not split one person into two visitors in your reports.',
            ],
            [
              <C>seentics.page()</C>,
              <span>
                Sends a pageview manually. Useful when you have set{' '}
                <C>data-auto-track=&quot;false&quot;</C>.
              </span>,
            ],
            [
              <C>seentics.flush()</C>,
              'Sends anything still queued immediately, rather than waiting for the next batch.',
            ],
          ]}
        />
        <CodeBlock
          filename="checkout.js"
          language="js"
          code={`// A custom event with properties.
seentics.track('add_to_cart', {
  sku: 'TRAILHEAD-32L',
  value: 168,
});

// Tie this visitor to your own user record.
seentics.identify('user_8412', { plan: 'growth' });

// Manual pageview, for data-auto-track="false".
seentics.page();`}
        />
      </DocSection>

      <DocSection title="Single-page apps">
        <P>
          Nothing to wire up. The tracker hooks <C>pushState</C>, <C>replaceState</C> and{' '}
          <C>popstate</C>, so a client-side route change is recorded as a pageview on its own. React
          Router, Next.js and Vue Router all work with the plain tag.
        </P>
        <P>
          If you would rather control it yourself, set <C>data-auto-track=&quot;false&quot;</C> and
          call <C>seentics.page()</C> from your router.
        </P>
      </DocSection>

      <DocSection title="What it costs the page">
        <RefTable
          columns={['File', 'Gzipped', 'When it loads']}
          rows={[
            [<C>seentics.min.js</C>, '~11 KB', 'Always. Analytics, funnels, heatmaps and automations are all in here.'],
            [
              <C>seentics-dom.min.js</C>,
              '~56 KB',
              'On demand — only when session recording is enabled for the site and this visitor is sampled in.',
            ],
          ]}
        />
        <P>
          If recording is off, the recorder is never fetched. If it is on but a visitor is not
          sampled, it is still never fetched for them.
        </P>
      </DocSection>

      <DocSection title="Storage and cookies">
        <P>
          The tracker sets no cookies — it never touches <C>document.cookie</C>. It does use browser
          storage: a visitor ID in <C>localStorage</C> so returning visitors are recognised, and{' '}
          <C>sessionStorage</C> for per-tab session state such as funnel progress.
        </P>
        <Callout kind="note" title="Worth knowing for your consent notice">
          A persistent identifier in <C>localStorage</C> is generally treated the same as a cookie
          under ePrivacy and the GDPR, even though it is not one. &ldquo;No cookies&rdquo; is
          accurate; &ldquo;nothing to consent to&rdquo; is a legal question for your own counsel.
          See <Link href="/docs/privacy" className="text-primary hover:underline">Privacy &amp;
          security</Link> for what is stored.
        </Callout>
        <P>
          When a site uses <strong>Strict</strong> consent mode, the tracker stays off until consent is
          granted. Set <C>data-consent=&quot;granted&quot;</C> on the script tag after your consent manager
          has approval, or set <C>window.seenticsConsent = true</C> before loading the tracker. The
          tracker also honors browser Do-Not-Track when that setting is enabled for the site.
        </P>
      </DocSection>

      <DocSection title="Excluding elements from recordings">
        <P>
          Every input is masked in recordings, always. It is not a setting —{' '}
          <C>maskAllInputs</C> is fixed on in the recorder&apos;s configuration, so typed values
          never leave the browser.
        </P>
        <P>
          For anything else you do not want captured, mark the element. Both attributes are read
          straight from the DOM by the recorder, so they work on any element at any time.
        </P>
        <RefTable
          columns={['Attribute', 'Effect']}
          rows={[
            [
              <C>data-seentics-block</C>,
              'The element is replaced by a placeholder of the same size in the recording. Its contents are never captured. Use this for anything genuinely sensitive.',
            ],
            [
              <C>data-seentics-mask</C>,
              'The element still renders and animates in the recording, but its text is replaced with asterisks. Use it where the layout matters and the words do not. Rich-text editors (contenteditable) are masked this way already, without the attribute.',
            ],
            [
              <C>data-seentics-ignore</C>,
              'The element is recorded, but changes inside it are not tracked. Use this for noisy widgets — tickers, clocks, live counters.',
            ],
          ]}
        />
        <CodeBlock
          filename="account.html"
          language="html"
          code={`<!-- Never captured. -->
<div data-seentics-block>
  <p>Card ending 4242 · Balance $1,204.55</p>
</div>

<!-- Shape kept, words replaced with asterisks. -->
<p data-seentics-mask>Hi Dana, your order ships Tuesday.</p>

<!-- Captured once, then left alone. -->
<div data-seentics-ignore>
  <span id="live-clock">14:22:07</span>
</div>`}
        />
      </DocSection>
    </DocPage>
  );
}
