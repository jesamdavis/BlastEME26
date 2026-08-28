const { normalizeTrackedLinkEntries } = require('../src/engine/sender');

describe('BlastEME generic tracked links', () => {
  test('normalizes object and string link forms into shared SEME tracking slots', () => {
    expect(normalizeTrackedLinkEntries({
      intrepid: { url: 'https://example.com/event', title: 'Event', category: 'event' },
      alo: 'https://example.com/alo',
    })).toEqual([
      {
        key: 'intrepid',
        slot: 'link:intrepid',
        affiliate_url: 'https://example.com/event',
        deal_title: 'Event',
        product_title: 'Event',
        deal_key: null,
        category: 'event',
      },
      {
        key: 'alo',
        slot: 'link:alo',
        affiliate_url: 'https://example.com/alo',
        deal_title: 'alo',
        product_title: 'alo',
        deal_key: null,
        category: null,
      },
    ]);
  });

  test('drops blank URLs instead of minting unusable click tokens', () => {
    expect(normalizeTrackedLinkEntries({ bad: { url: '' } })).toEqual([]);
  });
});
