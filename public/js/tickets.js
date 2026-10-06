'use strict';

// Jira-Links in Ticketnummern umwandeln, z.B.
//   https://firma.atlassian.net/browse/ITPKK-1234                          -> ITPKK-1234
//   https://firma.atlassian.net/jira/servicedesk/projects/ITPKB/queues/custom/33/ITPKB-1234 -> ITPKB-1234
//   https://firma.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7      -> ABC-7
// Die Datei laeuft im Browser und (fuer die Pruefung auf dem Server) auch in Node.
(function (root) {
  const KEY_RE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]+-\d+(?![A-Za-z0-9_])/g;
  const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

  function lastMatch(text) {
    const matches = text.match(KEY_RE);
    return matches ? matches[matches.length - 1] : null;
  }

  /** Ticketnummer aus einem Jira-Link, sonst null (fremde Adressen werden nicht angefasst). */
  function ticketKeyFromUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const path = (() => {
      try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
    })();
    const looksLikeJira =
      host.endsWith('atlassian.net') || /\/(browse|jira|servicedesk)\//i.test(path);
    if (!looksLikeJira) return null;

    // Boards/Backlogs: ...?selectedIssue=ABC-7
    const selected = url.searchParams.get('selectedIssue');
    if (selected && lastMatch(selected)) return lastMatch(selected);
    return lastMatch(path) || lastMatch(url.search ? decodeURIComponent(url.search) : '');
  }

  /** Ersetzt alle erkannten Jira-Links in einem Text durch die Ticketnummer. */
  function convertTicketLinks(text) {
    if (!text || !/https?:\/\//i.test(text)) return text;
    return text.replace(URL_RE, (match) => {
      // Satzzeichen am Ende gehoeren nicht zum Link
      const trailing = (match.match(/[.,;:!?)\]]+$/) || [''])[0];
      const key = ticketKeyFromUrl(trailing ? match.slice(0, -trailing.length) : match);
      return key ? key + trailing : match;
    });
  }

  /** Erste Ticketnummer, die beim Umwandeln der Links in einem Text entsteht (oder null). */
  function firstLinkedKey(text) {
    if (!text) return null;
    const links = text.match(URL_RE) || [];
    for (const link of links) {
      const trailing = (link.match(/[.,;:!?)\]]+$/) || [''])[0];
      const key = ticketKeyFromUrl(trailing ? link.slice(0, -trailing.length) : link);
      if (key) return key;
    }
    return null;
  }

  const api = { ticketKeyFromUrl, convertTicketLinks, firstLinkedKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
