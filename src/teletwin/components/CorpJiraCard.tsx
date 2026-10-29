import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { CorpJiraIssue } from '../api';

import buildClassName from '../../util/buildClassName';
import { fetchCorpJiraIssue } from '../api';
import { corpEngine } from '../engine';

import styles from './CorpJiraCard.module.scss';

const HOVER_DELAY = 350;
const HIDE_DELAY = 250;
const LONG_PRESS_DELAY = 500;
const CACHE_TTL = 5 * 60 * 1000;
const MISSING_TTL = 60 * 1000;
const CARD_WIDTH = 288;
const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;
const RE_ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/i;

type CacheEntry = { at: number; issue?: CorpJiraIssue };
type CardState = { issue: CorpJiraIssue; left: number; top: number; isAbove: boolean };

// Issue cards of the session; a missing or unconfigured tracker is remembered shortly, so links stay plain
const cache = new Map<string, CacheEntry>();

async function loadIssue(key: string) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.issue ? CACHE_TTL : MISSING_TTL)) return cached.issue;

  const credentials = corpEngine.credentials;
  if (!credentials) return undefined;
  try {
    const issue = await fetchCorpJiraIssue(credentials.server, credentials.token, key);
    cache.set(key, { at: Date.now(), issue });
    return issue;
  } catch {
    cache.set(key, { at: Date.now() });
    return undefined;
  }
}

// The issue key of a tracker link inside a corp message, as built from the server's `jiraBaseUrl`
function getIssueLink(target: EventTarget | null) {
  const baseUrl = corpEngine.linkRule?.baseUrl;
  if (!baseUrl || !(target instanceof Element)) return undefined;
  const anchor = target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor?.closest('.Message') || !anchor.href.startsWith(baseUrl)) return undefined;
  const key = decodeURIComponent(anchor.href.slice(baseUrl.length)).split(/[?#/]/)[0];

  return RE_ISSUE_KEY.test(key) ? { anchor, key: key.toUpperCase() } : undefined;
}

function placeCard(anchor: Element, issue: CorpJiraIssue): CardState {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN));
  const isAbove = rect.top > window.innerHeight / 2;

  return {
    issue, left, isAbove, top: isAbove ? window.innerHeight - rect.top + CARD_GAP : rect.bottom + CARD_GAP,
  };
}

// Hover (desktop) or long press (touch) on a Jira link in a corp message shows the issue card
const CorpJiraCard = () => {
  const [card, setCard] = useState<CardState | undefined>();

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let currentAnchor: Element | undefined;
    let shouldSkipClick = false;

    const show = async (anchor: Element, key: string) => {
      currentAnchor = anchor;
      const issue = await loadIssue(key);
      if (!issue || currentAnchor !== anchor || !anchor.isConnected) return;
      setCard(placeCard(anchor, issue));
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        currentAnchor = undefined;
        setCard(undefined);
      }, HIDE_DELAY);
    };

    const handleOver = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-corp-jira-card]')) {
        clearTimeout(hideTimer);
        return;
      }
      const link = getIssueLink(e.target);
      if (!link) {
        if (currentAnchor) scheduleHide();
        clearTimeout(showTimer);
        return;
      }
      clearTimeout(hideTimer);
      if (link.anchor === currentAnchor) return;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => void show(link.anchor, link.key), HOVER_DELAY);
    };
    const handleTouchStart = (e: TouchEvent) => {
      const link = getIssueLink(e.target);
      clearTimeout(showTimer);
      if (!link) {
        if (currentAnchor && !(e.target instanceof Element && e.target.closest('[data-corp-jira-card]'))) {
          scheduleHide();
        }
        return;
      }
      showTimer = setTimeout(() => {
        shouldSkipClick = true;
        void show(link.anchor, link.key);
      }, LONG_PRESS_DELAY);
    };
    const cancelPress = () => clearTimeout(showTimer);
    // The long press opened the card: the following click must not open the link
    const handleClick = (e: MouseEvent) => {
      if (!shouldSkipClick) return;
      shouldSkipClick = false;
      if (getIssueLink(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener('mouseover', handleOver);
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', cancelPress);
    document.addEventListener('touchmove', cancelPress, { passive: true });
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', scheduleHide, true);

    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      document.removeEventListener('mouseover', handleOver);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', cancelPress);
      document.removeEventListener('touchmove', cancelPress);
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', scheduleHide, true);
    };
  }, []);

  if (!card) return undefined;
  const { issue } = card;
  const meta = [issue.type, issue.priority].filter(Boolean).join(' · ');
  const statusClassName = styles[`status-${issue.statusCategory}`] || styles['status-new'];

  return (
    <div
      className={styles.card}
      data-corp-jira-card
      style={`left: ${card.left}px; ${card.isAbove ? 'bottom' : 'top'}: ${card.top}px; width: ${CARD_WIDTH}px`}
    >
      <div className={styles.header}>
        <a className={styles.key} href={issue.url} target="_blank" rel="noopener noreferrer">{issue.key}</a>
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      <div className={styles.summary} dir="auto">{issue.summary}</div>
      <div className={styles.footer}>
        <span className={buildClassName(styles.status, statusClassName)}>
          {issue.status}
        </span>
        {issue.assignee && <span className={styles.assignee}>{issue.assignee}</span>}
      </div>
    </div>
  );
};

export default memo(CorpJiraCard);
