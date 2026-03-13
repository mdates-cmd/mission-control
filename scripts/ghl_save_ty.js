const http = require('http');
const WebSocket = require('/app/node_modules/.pnpm/ws@8.19.0/node_modules/ws');
const fs = require('fs');
const https = require('https');

const TY_PAGE_ID = 'TPW5kxIJUZDShW5E3v1U';
const SALES_PAGE_ID = 'vQZ9JrBYtzug8hl5MmWf';
const FUNNEL_ID = 'P61iua8MR5rLtvFiKa4C';

http.get('http://127.0.0.1:18800/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', async () => {
    const ts = JSON.parse(d);
    const main = ts.find(t => t.type === 'page' && t.url.includes('gohighlevel'));
    const ws = new WebSocket(main.webSocketDebuggerUrl);
    let id = 1, token = null, captured = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: id++, method: 'Network.enable' }));
      ws.send(JSON.stringify({ id: id++, method: 'Page.navigate', params: {
        url: `https://app.gohighlevel.com/location/nJBTL0pKOllLF6RnuDKo/page-builder/${SALES_PAGE_ID}`
      }}));
      console.log('Navigating to Sales page builder...');
    });

    ws.on('message', async msg => {
      const r = JSON.parse(msg);
      if (r.method === 'Network.requestWillBeSent') {
        const req = r.params && r.params.request;
        const url = (req && req.url) || '';
        const tok = req && req.headers && req.headers['token-id'];
        if (tok) token = tok;

        if (url.includes('firebasestorage') && url.includes(SALES_PAGE_ID) && !captured) {
          captured = true;
          console.log('Sales page FB URL captured, token:', token ? 'yes' : 'no');
          fs.writeFileSync('/home/node/.openclaw/workspace/scripts/ghl_token.txt', token || '');

          setTimeout(async () => {
            try {
              const fbData = await new Promise((resolve, reject) => {
                https.get(url, r2 => {
                  let bd = ''; r2.on('data', c => bd += c); r2.on('end', () => resolve(bd));
                }).on('error', reject);
              });

              const pageStructure = JSON.parse(fbData);
              const sections = (pageStructure.pageData && pageStructure.pageData.sections) || [];
              console.log('Sales page sections:', sections.length);
              fs.writeFileSync('/home/node/.openclaw/workspace/scripts/sales_structure.json', fbData.slice(0, 5000));

              if (sections.length === 0) {
                console.log('Sales page empty - cannot use as template');
                ws.close();
                return;
              }

              const firstSection = sections[0];
              const html = fs.readFileSync('/home/node/.openclaw/workspace/life/projects/apex/website/thank-you-ghl.html', 'utf8');

              const newSection = JSON.parse(JSON.stringify(firstSection));
              newSection.id = 'ty-sec-001';
              newSection.pageId = TY_PAGE_ID;
              if (newSection.metaData) {
                newSection.metaData.id = 'ty-sec-001';
                newSection.metaData.child = ['ty-row-001'];
              }

              const rowEl = newSection.elements && newSection.elements.find(e => e.type === 'row');
              const colEl = newSection.elements && newSection.elements.find(e => e.type === 'col');

              newSection.elements = [];
              if (rowEl) {
                rowEl.id = 'ty-row-001';
                rowEl.child = ['ty-col-001'];
                newSection.elements.push(rowEl);
              }
              if (colEl) {
                colEl.id = 'ty-col-001';
                colEl.child = ['ty-html-001'];
                newSection.elements.push(colEl);
              }
              newSection.elements.push({
                id: 'ty-html-001', type: 'html', child: [], class: {},
                styles: { paddingLeft: { unit: 'px', value: 0 }, paddingRight: { value: 0, unit: 'px' }, paddingTop: { value: 0, unit: 'px' }, paddingBottom: { value: 0, unit: 'px' }, marginTop: { unit: 'px', value: 0 }, marginBottom: { unit: 'px', value: 0 } },
                extra: { code: { value: html }, visibility: { value: { hideDesktop: false, hideMobile: false } }, customClass: { value: [] } },
                wrapper: {}, meta: 'html', tagName: 'c-html', title: 'Custom HTML', mobileStyles: {}, mobileWrapper: {}
              });

              const tyPayload = {
                funnelId: FUNNEL_ID,
                pageData: Object.assign({}, pageStructure.pageData, { sections: [newSection] }),
                pageVersion: Date.now(),
                manualSave: true
              };

              const body = JSON.stringify(tyPayload);
              console.log('Saving TY page. Body:', body.length, 'bytes');

              const saveReq = https.request({
                hostname: 'backend.leadconnectorhq.com',
                path: `/funnels/builder/autosave/${TY_PAGE_ID}`,
                method: 'POST',
                headers: {
                  'token-id': token, 'source': 'WEB_USER', 'channel': 'APP',
                  'Content-Type': 'application/json', 'version': '2021-07-28',
                  'Referer': 'https://page-builder.leadconnectorhq.com/',
                  'Origin': 'https://page-builder.leadconnectorhq.com',
                  'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0'
                }
              }, saveRes => {
                let sd = '';
                saveRes.on('data', c => sd += c);
                saveRes.on('end', async () => {
                  try {
                    const result = JSON.parse(sd);
                    if (result.pageDataUrl) {
                      console.log('✓ TY saved:', result.pageDataUrl.slice(0, 60));
                      fs.writeFileSync('/home/node/.openclaw/workspace/scripts/ty_save_result.json', JSON.stringify(result));
                      setTimeout(async () => {
                        try {
                          const vd = await new Promise((vr, vj) => {
                            https.get(result.pageDataDownloadUrl, vr2 => {
                              let vdd = ''; vr2.on('data', c => vdd += c); vr2.on('end', () => vr(vdd));
                            }).on('error', vj);
                          });
                          const vj = JSON.parse(vd);
                          const secs = (vj.pageData && vj.pageData.sections) || [];
                          console.log('Firebase verify: sections=' + secs.length);
                          const htmlEl = secs[0] && secs[0].elements && secs[0].elements.find(e => e.type === 'html');
                          if (htmlEl) console.log('✓ HTML confirmed:', htmlEl.extra.code.value.length, 'chars');
                          else console.log('✗ No HTML in Firebase');
                        } catch (e) { console.log('verify error:', e.message); }
                        ws.close();
                      }, 3000);
                    } else {
                      console.log('✗ TY save failed:', JSON.stringify(result).slice(0, 100));
                      ws.close();
                    }
                  } catch (e) { console.log('parse error:', e.message); ws.close(); }
                });
              });
              saveReq.on('error', e => { console.log('request error:', e.message); ws.close(); });
              saveReq.write(body);
              saveReq.end();

            } catch (e) { console.log('error:', e.message); ws.close(); }
          }, 2000);
        }
      }
    });

    ws.on('error', e => console.log('ws error:', e.message));
    setTimeout(() => {
      if (!captured) { console.log('Timeout. Token:', token ? 'yes' : 'no'); }
      ws.close();
    }, 30000);
  });
});
