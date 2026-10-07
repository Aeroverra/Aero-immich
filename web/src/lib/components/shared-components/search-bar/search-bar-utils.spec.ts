import {
  formatVideoLength,
  isPopoverContent,
  parseVideoLength,
} from '$lib/components/shared-components/search-bar/search-bar-utils';

describe('isPopoverContent', () => {
  const focusOutEventTo = (relatedTarget: EventTarget | null) => new FocusEvent('focusout', { relatedTarget });

  const createCalendarPopup = () => {
    const popup = document.createElement('div');
    popup.dataset.popoverContent = '';
    return popup;
  };

  it('returns true when focus moves to an element inside a calendar popup', () => {
    const popup = createCalendarPopup();
    const dayButton = document.createElement('button');
    popup.append(dayButton);

    expect(isPopoverContent(focusOutEventTo(dayButton))).toBe(true);
  });

  it('returns true when focus moves to the calendar popup itself', () => {
    const popup = createCalendarPopup();

    expect(isPopoverContent(focusOutEventTo(popup))).toBe(true);
  });

  it('returns false when focus moves to an element outside a calendar popup', () => {
    const button = document.createElement('button');

    expect(isPopoverContent(focusOutEventTo(button))).toBe(false);
  });

  it('returns false when focus does not move to another element', () => {
    expect(isPopoverContent(focusOutEventTo(null))).toBe(false);
  });
});

describe('video length', () => {
  it('reads seconds, m:ss and h:mm:ss as milliseconds', () => {
    expect(parseVideoLength('45')).toBe(45_000);
    expect(parseVideoLength(' 1:30 ')).toBe(90_000);
    expect(parseVideoLength('1:02:03')).toBe(3_723_000);
    expect(parseVideoLength('')).toBeUndefined();
  });

  it('refuses what is not a length', () => {
    expect(parseVideoLength('1.5')).toBeNull();
    expect(parseVideoLength('abc')).toBeNull();
    expect(parseVideoLength('1:2:3:4')).toBeNull();
  });

  it('writes lengths as m:ss, or h:mm:ss from an hour on', () => {
    expect(formatVideoLength(5000)).toBe('0:05');
    expect(formatVideoLength(90_000)).toBe('1:30');
    expect(formatVideoLength(3_723_000)).toBe('1:02:03');
  });
});
