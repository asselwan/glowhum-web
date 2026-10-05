const stop = new Set('a an and are as at be by can do does for from how i in is it me of on or the this to was were what when where which who why with you'.split(' '));

function words(value) {
  return [...new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(word => !stop.has(word));
}

export function guideBook(book, question) {
  const terms = words(question);
  if (!terms.length) return { found: false, message: 'Ask about a person, event, or idea in this book.' };
  let best;
  for (const [index, chapter] of (book.chapters || []).entries()) {
    const passage = chapter?.passage?.text;
    if (typeof passage !== 'string' || !Number.isInteger(chapter?.passage?.page)) continue;
    const haystack = new Set(words(passage));
    const matches = terms.filter(term => haystack.has(term));
    if (!matches.length) continue;
    const score = matches.length / terms.length;
    if (!best || score > best.score) best = { index, chapter, score, matches };
  }
  if (!best || (terms.length > 1 && best.score < 0.6)) return { found: false, message: 'I could not find that in this book’s chapter excerpts.' };
  return {
    found: true,
    match_type: 'word_overlap',
    claim_verified: false,
    message: `This passage mentions ${best.matches.join(', ')}. This word match does not verify your question or its claim. Read the passage and source page to check.`,
    chapter_index: best.index,
    chapter_title: best.chapter.title,
    page: best.chapter.passage.page,
    passage: best.chapter.passage.text,
    matched_terms: best.matches
  };
}
