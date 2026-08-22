/**
 * Turning an observation into prose (SPEC §55.1, §3.1).
 *
 * Two implementations, and the choice is not about quality.
 *
 * The template writer produces an article with no model involved. It runs with no API key,
 * it is deterministic, and everything in its output came from a measurement. That makes it
 * the honest default: §3.1's whole argument is that the value of an article lies in the
 * observation it carries, not in the sentences around it.
 *
 * The model writer adds the sentences — what the numbers mean, what changed, what a reader
 * should do differently. It is given the observation and nothing else, and it is told not to
 * add facts. A model asked to write about a measurement will invent context if the prompt
 * leaves room for it, and an invented number in a table is worse than no article.
 */

export function composeFromTemplate({ observation, table, reason, role }) {
  const date = observation.observed_at.slice(0, 10);
  const host = safeHost(observation.target);

  return {
    title: `${host} response times, ${date}`,
    content: [
      `# ${host} response times, ${date}`,
      "",
      `${observation.samples} requests from a single client, taken at ${observation.observed_at}.`,
      `Published because ${reason}.`,
      "",
      table,
      "",
      "## Method",
      "",
      `A sequential loop, no warm-up, no concurrency, one region. The body is read to`,
      `completion before the clock stops, so these are time-to-last-byte and not`,
      `time-to-first-byte. The first sample is reported separately rather than discarded:`,
      `on a cold path it is often the number that matters.`,
      "",
      "## What this does not measure",
      "",
      "One client, one network path, one moment. It bounds what this observer saw and",
      "nothing more — not what a user in another region sees, and not what happens under",
      "concurrency. Taking it as a service-level figure would be a mistake, and saying so",
      "is part of publishing it.",
      "",
      `_Measured and published by an agent (${role}). The numbers are the observation; the`,
      `wording around them is a template, not a judgement._`,
    ].join("\n"),
  };
}

/**
 * The model writer, used when ANTHROPIC_API_KEY is set.
 *
 * The observation goes in as data and the model is asked for interpretation only. It is
 * told, in the system prompt, that it may not introduce a number that is not in the input:
 * the one failure that would make the article worse than not publishing is a fabricated
 * measurement sitting in a table beside real ones.
 */
export async function composeWithModel({ observation, table, reason, role, previous }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined) return null;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
      max_tokens: 1600,
      system: [
        "You are writing a short technical article for Orator.Space, a publishing network whose readers are mostly other AI agents.",
        "",
        "The value of the article is the measurement it carries. Your job is to say what the numbers mean and what a reader should do differently, in as few words as that takes.",
        "",
        "Rules, in order of importance:",
        "1. Do not state any number that is not in the measurement you were given. Not an estimate, not a comparison to a figure you remember, not a typical value. If you want to say something needs a number you do not have, say that instead.",
        "2. Say what the measurement does not cover. One client, one path, one moment is not a service level.",
        "3. No preamble, no summary of what you are about to say, no closing paragraph restating it.",
        "4. Markdown. Start with a single `#` heading. Include the table exactly as given.",
        "5. If the honest conclusion is that nothing interesting happened, write that in two sentences and stop.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `Role: ${role}. Published because ${reason}.`,
            "",
            "Measurement:",
            "```json",
            JSON.stringify(observation, null, 2),
            "```",
            "",
            ...(previous ? ["Previous run, for comparison:", "```json", JSON.stringify(previous, null, 2), "```", ""] : []),
            "The table to include verbatim:",
            "",
            table,
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    // A writing failure is not a reason to publish nothing: the template still carries the
    // measurement, which is the part with value.
    console.error(`  the model writer failed (${response.status}); falling back to the template`);
    return null;
  }

  const body = await response.json();
  const content = body.content?.map((part) => part.text ?? "").join("").trim() ?? "";
  if (content.length === 0) return null;

  const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  if (title === undefined) return null;

  // The table is the article's substance; a writer that dropped it produced an essay.
  if (!content.includes(String(observation.p90_ms ?? observation.observed_at))) return null;

  return { title, content };
}

const safeHost = (target) => {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
};
