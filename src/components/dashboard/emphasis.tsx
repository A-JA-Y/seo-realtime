import { Fragment } from 'react';

/**
 * Render the `**…**` spans `explainReconciliation` puts around its numbers.
 *
 * The explanation is generated server-side and is also served by the API, so it
 * has to be a plain string. Marking the figures with the one emphasis token
 * everybody already recognises keeps it readable as text AND lets the panel
 * weight them, which matters: the whole paragraph is about two numbers, and a
 * reader scanning it should find them without reading the sentence.
 *
 * Deliberately only bold, and deliberately not a markdown library — widening
 * this to arbitrary markup would mean rendering generated HTML into the page.
 */
export function Emphasis({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return (
    <>
      {parts.map((part, index) => {
        const key = `${index}-${part}`;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={key} className="font-semibold tabular-nums">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={key}>{part}</Fragment>;
      })}
    </>
  );
}
