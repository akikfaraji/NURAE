/**
 * NURAE — built-in bots: five ready-to-run promotion templates.
 *
 * Each template is a real behavior configuration (validated by the same
 * schema the agent writes through) that instantiates into the user's
 * account with one click. Every template carries NURAE growth hooks:
 *
 *   - an "About NURAE" behavior whose link points at
 *     https://<site>/?ref=<ownerCode> — the platform referral loop, so the
 *     bot owner earns premium days when their audience signs up;
 *   - an attribution line under the welcome message;
 *   - community/channel shortcuts when the instance configures them.
 *
 * The templates run on plain NURAE primitives (behaviors, attributes,
 * remember/draw/top, deep links, copy buttons) — nothing here is
 * hardcoded into the pipeline; every behavior stays owner-editable after
 * instantiation.
 */

import type { BotBehaviorSpec, BehaviorButton } from './behavior';

// ---------------------------------------------------------------------------
// Links + catalog types
// ---------------------------------------------------------------------------

/** The instance's public faces — injected at instantiation time. */
export interface GrowthLinks {
  /** Where new users sign up (the NURAE instance serving this bot). */
  siteUrl: string;
  /** Optional Telegram community chat invite. */
  communityUrl?: string;
  /** Optional Telegram announcements channel invite. */
  channelUrl?: string;
}

export interface TemplateMeta {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: 'Growth' | 'Engagement' | 'Support' | 'Community';
  highlights: string[];
}

/** What the created bot looks like on the NURAE side. */
export interface BuiltTemplate {
  name: string;
  description: string;
  systemPrompt: string;
  behaviors: BotBehaviorSpec[];
}

// ---------------------------------------------------------------------------
// Catalog metadata (pure data — safe to import from the client)
// ---------------------------------------------------------------------------

export const TEMPLATE_CATALOG: TemplateMeta[] = [
  {
    id: 'referral-ambassador',
    name: 'Referral Ambassador',
    tagline: 'Your users invite their friends — and get credited for it.',
    description:
      'A viral referral program in a bot. Every user gets a personal invite link, arrivals are counted automatically, and a leaderboard keeps the competition alive.',
    category: 'Growth',
    highlights: [
      'Personal invite link per user (deep-link referral tracking)',
      'Invite counter and Top referrers leaderboard',
      'Winner-ready for milestone rewards later',
    ],
  },
  {
    id: 'giveaway',
    name: 'Giveaway Bot',
    tagline: 'Press to enter, draw a live winner — the channel-growth classic.',
    description:
      'Collect entries with one button, then draw a random winner right in the chat with /draw. Honest counters — nobody enters twice, no shows without entrants.',
    category: 'Growth',
    highlights: [
      'One-tap entry, remembered per user',
      'Live random draw with winner announcement',
      'Rules behavior you can adapt in one edit',
    ],
  },
  {
    id: 'daily-trivia',
    name: 'Daily Trivia',
    tagline: 'Scored quizzes and a leaderboard — the reason people come back.',
    description:
      'A quiz host that remembers every score. Buttons give instant right/wrong feedback, points add up automatically, and the leaderboard settles who actually reads the announcements.',
    category: 'Engagement',
    highlights: [
      'Instant-feedback quiz buttons (two starter questions)',
      'Automatic scoring with add-mode counters',
      'Personal score and Top players leaderboard',
    ],
  },
  {
    id: 'support-faq',
    name: 'Support & FAQ',
    tagline: 'Instant answers, AI for the long tail, questions reach the team.',
    description:
      'Canned answers for the questions you get ten times a day, a collect flow that forwards everything else to the team, and an AI fallback that answers the rest — politely pointing builders at NURAE.',
    category: 'Support',
    highlights: [
      'FAQ shortcuts (pricing, refunds, hours)',
      'Questions collected into your Audience table',
      'AI fallback answers the rest (needs an AI key)',
    ],
  },
  {
    id: 'community-hub',
    name: 'Community Hub',
    tagline: 'Announcements land first here — and sharing is one tap.',
    description:
      'The announcements home for a community: subscribers are remembered, broadcasts from the dashboard reach everyone, and a copy-ready invite link turns every member into a promoter.',
    category: 'Community',
    highlights: [
      'Subscription flag remembered per user',
      'Pairs with dashboard broadcasts and schedules',
      'One-tap share with tracked invite links',
    ],
  },
];

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The owner's NURAE referral link (premium days on qualified signups). */
export function nuraeReferralLink(siteUrl: string, refCode: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  return `${base}/?ref=${encodeURIComponent(refCode)}`;
}

function nuraeAboutBehavior(links: GrowthLinks, refCode: string): BotBehaviorSpec {
  const buttons: BehaviorButton[] = [
    {
      label: 'Build your own bot',
      action: { kind: 'link', url: nuraeReferralLink(links.siteUrl, refCode) },
    },
  ];
  if (links.communityUrl) {
    buttons.push({ label: 'NURAE community', action: { kind: 'link', url: links.communityUrl } });
  }
  if (links.channelUrl) {
    buttons.push({ label: 'NURAE channel', action: { kind: 'link', url: links.channelUrl } });
  }
  return {
    id: 'nurae_about',
    title: 'About NURAE',
    when: { type: 'button' },
    steps: [
      {
        type: 'message',
        text:
          'This bot is built and run on **NURAE** — describe what a bot should do, and NURAE builds it: media, Stars payments, quizzes, referral programs, broadcasts, all of it.\n\nBuild your own in minutes:',
        buttons,
      },
    ],
  };
}

/** Attribution footer appended to every template's welcome message. */
function attributionLine(links: GrowthLinks, refCode: string): string {
  return `\n\n—\nBuilt with [NURAE](${nuraeReferralLink(links.siteUrl, refCode)}) — make your own bot in minutes.`;
}

/**
 * Group greet — when the bot is added to a GROUP and a new member arrives,
 * greet them publicly and funnel them into the private bot flow (where the
 * growth mechanics live: streaks, invites, entries). Included by every
 * template; the public bot username deep-link starts the private chat.
 */
function groupGreetBehavior(): BotBehaviorSpec {
  return {
    id: 'group_greet',
    title: 'Greet new group members',
    when: { type: 'member_joined' },
    steps: [
      {
        type: 'message',
        text:
          '👋 Welcome, {{name}}! This group runs on this bot — tap below and press *Start* in the private chat to join the game, the leaderboard and the rewards.',
        buttons: [{ label: 'Join — press Start', action: { kind: 'link', url: 'https://t.me/{{bot_username}}' } }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The five templates
// ---------------------------------------------------------------------------

const AMBASSADOR_SYSTEM_PROMPT =
  'You are the host of a referral program. You are warm, brief and motivating. ' +
  'You point people at their invite link and the leaderboard. You never invent rewards — ' +
  'rewards are whatever the bot owner announces.';

function buildReferralAmbassador(links: GrowthLinks, refCode: string): BuiltTemplate {
  return {
    name: 'Referral Ambassador',
    description: 'Referral program bot — personal invite links, invite counters, top referrers.',
    systemPrompt: AMBASSADOR_SYSTEM_PROMPT,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome + program menu',
        when: { type: 'start' },
        steps: [
          {
            type: 'message',
            text:
              'Welcome, {{name}}! 🎁\n\nHere is the deal: every friend who starts this bot through your personal link counts as your invite. Share your link, climb the leaderboard, unlock reward tiers at 3, 5, 10 and 25 invites.\n\nPick an option below.',
            buttons: [
                { label: 'Get my link', action: { kind: 'flow', behaviorId: 'invite_link' } },
                { label: 'My invites', action: { kind: 'flow', behaviorId: 'my_invites' } },
                { label: 'Rewards', action: { kind: 'flow', behaviorId: 'rewards' } },
                { label: 'Top referrers', action: { kind: 'flow', behaviorId: 'top_referrers' } },
                { label: 'About NURAE', action: { kind: 'flow', behaviorId: 'nurae_about' } },
              ],
          },
        ],
      },
      {
        id: 'invite_link',
        title: 'Personal invite link',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'Your personal invite link — one link, just for you:\n\nhttps://t.me/{{bot_username}}?start=ref_{{chat_id}}\n\nShare it anywhere. Every friend who starts the bot through it counts as your invite.',
            buttons: [
                {
                  label: 'Copy my link',
                  action: { kind: 'copy', text: 'https://t.me/{{bot_username}}?start=ref_{{chat_id}}' },
                },
                { label: 'Check my invites', action: { kind: 'flow', behaviorId: 'my_invites' } },
              ],
          },
        ],
      },
      {
        id: 'my_invites',
        title: 'My invite count + reward tiers',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'You have **{{invites|0}}** invited friend(s) so far. Keep sharing — the top referrers get noticed first. 🚀',
            buttons: [
                { label: 'Get my link', action: { kind: 'flow', behaviorId: 'invite_link' } },
                { label: 'Top referrers', action: { kind: 'flow', behaviorId: 'top_referrers' } },
              ],
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 3,
              message:
                '🏆 Milestone unlocked: **3 invites!** You are officially a grower — the 5-invite tier (featured on the leaderboard) is within reach.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 5,
              message:
                '🏆 **5 invites!** You are now featured on the wall of fame. The 10-invite tier comes with the owner’s special reward — keep going.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 10,
              message:
                '🏆 **10 invites — elite tier!** The owner has been notified to deliver your special reward. The 25-invite legend tier awaits.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 25,
              message:
                '👑 **25 invites — LEGEND.** You are one of the top growth engines of this entire community. The owner owes you a legendary reward.',
            },
          },
        ],
      },
      {
        id: 'rewards',
        title: 'Reward tiers',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              '🎖 **Reward ladder**\n\n• **3 invites** — Grower title + shoutout\n• **5 invites** — Featured on the wall of fame\n• **10 invites** — Special reward from the team\n• **25 invites** — Legend status, top-priority rewards\n\nYour progress: **{{invites|0}}** invite(s). Milestones unlock automatically the next time you check your invites.',
            buttons: [
                { label: 'Get my link', action: { kind: 'flow', behaviorId: 'invite_link' } },
                { label: 'My invites', action: { kind: 'flow', behaviorId: 'my_invites' } },
              ],
          },
        ],
      },
      {
        id: 'top_referrers',
        title: 'Top referrers leaderboard',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: 'The wall of fame — share your link to climb it:',
            buttons: [{ label: 'Get my link', action: { kind: 'flow', behaviorId: 'invite_link' } }],
          },
          { type: 'top', top: { attribute: 'invites', title: '🏆 Top referrers', limit: 10 } },
        ],
      },
      {
        id: 'ref_join',
        title: 'Arrived via a friend’s invite',
        when: { type: 'payload', value: 'ref_' },
        steps: [
          {
            type: 'message',
            text:
              '🎉 Welcome! You arrived through a friend’s invite — they just got the credit.\n\nNow it is your turn: grab your own link and pass it on.',
            buttons: [
                { label: 'Get my link', action: { kind: 'flow', behaviorId: 'invite_link' } },
                { label: 'Top referrers', action: { kind: 'flow', behaviorId: 'top_referrers' } },
              ],
          },
        ],
      },
      groupGreetBehavior(),
      nuraeAboutBehavior(links, refCode),
    ],
  };
}

const GIVEAWAY_SYSTEM_PROMPT =
  'You are the host of a giveaway. You are playful but precise about the rules. ' +
  'You never promise extra entries or change the prize — that is the owner’s call.';

/**
 * @username of a PUBLIC t.me link (t.me/<name>) — the only form the join
 * gate can verify. Invite links (t.me/+…) and non-t.me URLs yield null.
 */
function publicChannelHandle(url: string | undefined): string | null {
  const m = /^https?:\/\/t\.me\/([a-zA-Z0-9_]{4,64})\/?$/i.exec((url ?? '').trim());
  return m ? `@${m[1]}` : null;
}

function buildGiveaway(links: GrowthLinks, refCode: string): BuiltTemplate {
  const welcomeButtons: BehaviorButton[] = [
    { label: 'Enter the giveaway', action: { kind: 'flow', behaviorId: 'enter' } },
    { label: 'Rules', action: { kind: 'flow', behaviorId: 'rules' } },
  ];
  if (links.communityUrl) {
    welcomeButtons.push({ label: 'Bonus: join the NURAE community', action: { kind: 'link', url: links.communityUrl } });
  }
  welcomeButtons.push({ label: 'About NURAE', action: { kind: 'flow', behaviorId: 'nurae_about' } });
  // When the instance runs a public announcements channel, entry is
  // join-gated: every entrant becomes a channel member. That is the growth
  // engine of this template — a giveaway that feeds the channel.
  const channel = publicChannelHandle(links.channelUrl);
  const gateSteps: BuiltTemplate['behaviors'][number]['steps'] = channel
    ? [
        {
          type: 'verify_join',
          verifyJoin: {
            chat: channel,
            prompt:
              'To enter, join our announcements channel — winners and future giveaways are announced there first. Tap *Join the channel*, then come back and press *Enter the giveaway* again.',
            buttonText: 'Join the channel',
          },
        },
      ]
    : [];
  return {
    name: 'Giveaway Bot',
    description: 'Giveaway bot — one-tap entries, honest counters, live /draw winner announcement.',
    systemPrompt: GIVEAWAY_SYSTEM_PROMPT,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome + enter',
        when: { type: 'start' },
        steps: [
          {
            type: 'message',
            text:
              '🎁 The giveaway is live!\n\nPrize: **edit this line** to name your prize and what it is worth.\n\nHow to enter: press Enter below — that is all. The winner is drawn right here in the chat with /draw.',
            buttons: welcomeButtons,
          },
        ],
      },
      {
        id: 'enter',
        title: 'Enter the giveaway',
        when: { type: 'button' },
        steps: [
          ...gateSteps,
          { type: 'remember', remember: { attribute: 'entered', value: 'yes', mode: 'set' } },
          {
            type: 'message',
            text:
              'You are in! 🍀 Your entry is locked — one per person. Winners are announced in this chat and in the announcements channel.' +
              (channel ? ' Stay in the channel so you never miss the draw.' : ''),
            buttons: [
                { label: 'Rules', action: { kind: 'flow', behaviorId: 'rules' } },
                { label: 'Share the giveaway', action: { kind: 'flow', behaviorId: 'share' } },
              ],
          },
        ],
      },
      {
        id: 'share',
        title: 'Share the giveaway',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'More friends, bigger draws — and the owner notices who grows this giveaway. Pass it on: 🙌',
            buttons: [
                {
                  label: 'Copy invite link',
                  action: { kind: 'copy', text: '🎁 Free giveaway — press Start to enter: https://t.me/{{bot_username}}?start=ref_{{chat_id}}' },
                },
              ],
          },
        ],
      },
      {
        id: 'rules',
        title: 'Giveaway rules',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              '**Rules**\n\n• One entry per person — pressing Enter again changes nothing\n• The winner is drawn at random with /draw, in public\n• The prize is delivered in this chat, for free',
          },
        ],
      },
      {
        id: 'draw',
        title: 'Draw the winner (/draw)',
        when: { type: 'command', command: '/draw' },
        steps: [
          { type: 'message', text: '🎲 Drawing a winner among everyone who entered…' },
          {
            type: 'draw',
            draw: {
              attribute: 'entered',
              announce:
                '🎉 The winner is **{{winner_name}}** ({{winner_chat}}) — drawn from {{count}} entrant(s). Congratulations! Contact the team in this chat to receive the prize.',
              emptyText: 'No entries yet — nobody to draw from. Press Enter first!',
            },
          },
        ],
      },
      groupGreetBehavior(),
      nuraeAboutBehavior(links, refCode),
    ],
  };
}

const TRIVIA_SYSTEM_PROMPT =
  'You are a quick-witted trivia host. Keep answers short, playful and factual. ' +
  'When asked about scores or the leaderboard, point at the buttons. ' +
  'You never make up extra questions with scoring — scoring lives in the configured quiz behaviors.';

function buildDailyTrivia(links: GrowthLinks, refCode: string): BuiltTemplate {
  return {
    name: 'Trivia Bot',
    description: 'Daily trivia bot — scored quizzes, instant feedback, leaderboard.',
    systemPrompt: TRIVIA_SYSTEM_PROMPT,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome + first question',
        when: { type: 'start' },
        steps: [
          { type: 'streak', streak: { attribute: 'streak' } },
          {
            type: 'message',
            text:
              '🧠 Trivia time, {{name}}!\n\n🔥 Daily streak: **{{streak|1}} day(s)** — come back every day to grow it. Your record: **{{streak_best|1}}**.\n\nOne question at a time — every correct answer scores a point. Answer by tapping, no typing needed.\n\nRound 1, question 1 is ready.',
            buttons: [
                { label: 'Question 1', action: { kind: 'flow', behaviorId: 'q1' } },
                { label: 'My score', action: { kind: 'flow', behaviorId: 'my_score' } },
                { label: 'Leaderboard', action: { kind: 'flow', behaviorId: 'top_score' } },
                { label: 'About NURAE', action: { kind: 'flow', behaviorId: 'nurae_about' } },
              ],
          },
        ],
      },
      {
        id: 'q1',
        title: 'Question 1 — the Red Planet',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '**Question 1**\n\nWhich planet is known as the Red Planet?',
            buttons: [
                { label: 'Venus', action: { kind: 'flow', behaviorId: 'q1_wrong_venus' } },
                { label: 'Mars', action: { kind: 'flow', behaviorId: 'q1_correct' } },
                { label: 'Jupiter', action: { kind: 'flow', behaviorId: 'q1_wrong_jupiter' } },
              ],
          },
        ],
      },
      {
        id: 'q1_correct',
        title: 'Q1 — correct (Mars)',
        when: { type: 'button' },
        steps: [
          { type: 'remember', remember: { attribute: 'score', value: '1', mode: 'add' } },
          {
            type: 'message',
            text: '✅ Correct! Mars it is — the iron oxide dust gives it the red glow.\n\nYour score: **{{score}}** point(s).',
            buttons: [{ label: 'Next question', action: { kind: 'flow', behaviorId: 'q2' } }],
          },
        ],
      },
      {
        id: 'q1_wrong_venus',
        title: 'Q1 — wrong (Venus)',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '❌ Not Venus — Venus just hides its surface under clouds. The Red Planet is **Mars**.\n\nYour score: **{{score|0}}** point(s).',
            buttons: [{ label: 'Next question', action: { kind: 'flow', behaviorId: 'q2' } }],
          },
        ],
      },
      {
        id: 'q1_wrong_jupiter',
        title: 'Q1 — wrong (Jupiter)',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '❌ Not Jupiter — Jupiter is the giant, not the red one. The Red Planet is **Mars**.\n\nYour score: **{{score|0}}** point(s).',
            buttons: [{ label: 'Next question', action: { kind: 'flow', behaviorId: 'q2' } }],
          },
        ],
      },
      {
        id: 'q2',
        title: 'Question 2 — most native speakers',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '**Question 2**\n\nWhich language has the most native speakers in the world?',
            buttons: [
                { label: 'English', action: { kind: 'flow', behaviorId: 'q2_wrong_english' } },
                { label: 'Mandarin Chinese', action: { kind: 'flow', behaviorId: 'q2_correct' } },
              { label: 'Spanish', action: { kind: 'flow', behaviorId: 'q2_wrong_spanish' } }],
          },
        ],
      },
      {
        id: 'q2_correct',
        title: 'Q2 — correct (Mandarin)',
        when: { type: 'button' },
        steps: [
          { type: 'remember', remember: { attribute: 'score', value: '1', mode: 'add' } },
          {
            type: 'message',
            text: '✅ Correct! Mandarin Chinese — roughly 940 million native speakers.\n\nYour score: **{{score}}** point(s). That is the end of this round — new questions land regularly.',
            buttons: [
                { label: 'Leaderboard', action: { kind: 'flow', behaviorId: 'top_score' } },
                { label: 'Back to start', action: { kind: 'flow', behaviorId: 'welcome' } },
              ],
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'score',
              value: 5,
              message:
                '🏆 **Quiz master unlocked — 5 correct answers!** You now hold *Quiz Master* status. The owner watches this board — keep your crown.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'score',
              value: 15,
              message:
                '👑 **15 correct answers — Trivia Legend!** Very few ever reach this. The owner has been notified.',
            },
          },
        ],
      },
      {
        id: 'q2_wrong_english',
        title: 'Q2 — wrong (English)',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '❌ English has the most *learners*, but the most native speakers is **Mandarin Chinese** (~940M).\n\nYour score: **{{score|0}}** point(s).',
            buttons: [{ label: 'Back to start', action: { kind: 'flow', behaviorId: 'welcome' } }],
          },
        ],
      },
      {
        id: 'q2_wrong_spanish',
        title: 'Q2 — wrong (Spanish)',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: '❌ Close — Spanish is third. The most native speakers is **Mandarin Chinese** (~940M).\n\nYour score: **{{score|0}}** point(s).',
            buttons: [{ label: 'Back to start', action: { kind: 'flow', behaviorId: 'welcome' } }],
          },
        ],
      },
      {
        id: 'my_score',
        title: 'My score',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: 'Your score: **{{score|0}}** point(s). Answer the next question to add more.',
            buttons: [
                { label: 'Question 1', action: { kind: 'flow', behaviorId: 'q1' } },
                { label: 'Leaderboard', action: { kind: 'flow', behaviorId: 'top_score' } },
              ],
          },
        ],
      },
      {
        id: 'top_score',
        title: 'Trivia leaderboard',
        when: { type: 'button' },
        steps: [
          { type: 'top', top: { attribute: 'score', title: '🧠 Trivia leaderboard', limit: 10 } },
          {
            type: 'message',
            text: 'Play the next question to climb it:',
            buttons: [{ label: 'Question 1', action: { kind: 'flow', behaviorId: 'q1' } }],
          },
        ],
      },
      groupGreetBehavior(),
      nuraeAboutBehavior(links, refCode),
    ],
  };
}

const SUPPORT_SYSTEM_PROMPT =
  'You are the support assistant for this business. Answer briefly, helpfully and honestly. ' +
  'If the question is about how this bot was built or about building bots in general, mention that ' +
  'this bot runs on NURAE and anyone can build one in minutes. Never invent prices, dates or policies — ' +
  'say the team will confirm instead.';

function buildSupportFaq(links: GrowthLinks, refCode: string): BuiltTemplate {
  return {
    name: 'Support Bot',
    description: 'Support & FAQ bot — instant answers, question intake, AI fallback for the rest.',
    systemPrompt: SUPPORT_SYSTEM_PROMPT,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome + help menu',
        when: { type: 'start' },
        steps: [
          {
            type: 'message',
            text:
              'Hi {{name}} 👋 Ask me anything about our product — I answer instantly. If I cannot, your question goes straight to the team.',
            buttons: [
                { label: 'FAQ', action: { kind: 'flow', behaviorId: 'faq' } },
                { label: 'Contact the team', action: { kind: 'flow', behaviorId: 'contact' } },
                { label: 'Share this bot', action: { kind: 'flow', behaviorId: 'share_bot' } },
              { label: 'About NURAE', action: { kind: 'flow', behaviorId: 'nurae_about' } }],
          },
        ],
      },
      {
        id: 'share_bot',
        title: 'Share this bot',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: 'Know someone who needs this? Pass it on — it takes one tap. 🙌',
            buttons: [
                {
                  label: 'Copy invite link',
                  action: { kind: 'copy', text: 'Check out this bot: https://t.me/{{bot_username}}?start=ref_{{chat_id}}' },
                },
              ],
          },
        ],
      },
      {
        id: 'faq',
        title: 'FAQ menu',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: 'The quick answers — tap a topic:',
            buttons: [
                { label: 'Pricing', action: { kind: 'flow', behaviorId: 'faq_pricing' } },
                { label: 'Refunds', action: { kind: 'flow', behaviorId: 'faq_refunds' } },
                { label: 'Hours', action: { kind: 'flow', behaviorId: 'faq_hours' } },
              { label: 'Back', action: { kind: 'flow', behaviorId: 'welcome' } }],
          },
        ],
      },
      {
        id: 'faq_pricing',
        title: 'FAQ — pricing',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'Pricing depends on what you pick — send **Contact the team** and we will quote you personally. No hidden fees, ever.',
            buttons: [{ label: 'Contact the team', action: { kind: 'flow', behaviorId: 'contact' } }],
          },
        ],
      },
      {
        id: 'faq_refunds',
        title: 'FAQ — refunds',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'Changed your mind? Message us within 14 days of your purchase and we will make it right — refund or replacement, your call.',
            buttons: [{ label: 'Contact the team', action: { kind: 'flow', behaviorId: 'contact' } }],
          },
        ],
      },
      {
        id: 'faq_hours',
        title: 'FAQ — hours',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              'We reply every day, 9:00–21:00. Messages at night are answered first thing in the morning — the team sees everything you send here.',
          },
        ],
      },
      {
        id: 'contact',
        title: 'Contact the team',
        when: { type: 'button' },
        steps: [
          {
            type: 'collect',
            collect: {
              attribute: 'question',
              prompt: 'Tell me what you need help with — the team will reply right here in this chat.',
            },
          },
          {
            type: 'message',
            text: 'Thanks! Your question is with the team — watch this chat for the reply. ✅',
          },
        ],
      },
      {
        id: 'ai_fallback',
        title: 'Anything else → AI',
        when: { type: 'anything_else' },
        steps: [{ type: 'ai', instruction: 'Answer the user’s question helpfully and briefly.' }],
      },
      groupGreetBehavior(),
      nuraeAboutBehavior(links, refCode),
    ],
  };
}

const HUB_SYSTEM_PROMPT =
  'You are the voice of this community: warm, clear and hype-free. ' +
  'You point people at announcements and the invite link. You never invent news — ' +
  'announcements come from the team’s broadcasts.';

function buildCommunityHub(links: GrowthLinks, refCode: string): BuiltTemplate {
  const welcomeButtons: BehaviorButton[] = [
    { label: 'Announcements', action: { kind: 'flow', behaviorId: 'news' } },
    { label: 'Invite challenge', action: { kind: 'flow', behaviorId: 'invite_challenge' } },
    { label: 'Share this bot', action: { kind: 'flow', behaviorId: 'share' } },
  ];
  if (links.communityUrl) {
    welcomeButtons.push({ label: 'Join the NURAE community', action: { kind: 'link', url: links.communityUrl } });
  }
  welcomeButtons.push({ label: 'About NURAE', action: { kind: 'flow', behaviorId: 'nurae_about' } });
  return {
    name: 'Community Hub',
    description: 'Announcements hub bot — subscriptions, daily check-in streaks, broadcasts, one-tap sharing with tracked links.',
    systemPrompt: HUB_SYSTEM_PROMPT,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome + subscribe + check-in',
        when: { type: 'start' },
        steps: [
          { type: 'remember', remember: { attribute: 'subscribed', value: 'yes', mode: 'set' } },
          { type: 'streak', streak: { attribute: 'checkin' } },
          {
            type: 'message',
            text:
              'Welcome to the hub, {{name}} 📣\n\nAnnouncements land here first — you are on the list. Big things are coming; keep notifications on.\n\n🔥 Check-in streak: **{{checkin|1}} day(s)** (record: **{{checkin_best|1}}**). Show up daily — the most consistent members get noticed first.',
            buttons: welcomeButtons,
          },
        ],
      },
      {
        id: 'invite_challenge',
        title: 'Invite challenge',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              '🎯 **The invite challenge**\n\nBring friends into this community — every friend who starts this bot through your link counts:\n\n• **3 invites** — Connector title\n• **10 invites** — Community star, featured by the team\n• **25 invites** — Core member status\n\nYour count: **{{invites|0}}**. Milestones unlock automatically when you check here.',
            buttons: [
                {
                  label: 'Copy my invite link',
                  action: { kind: 'copy', text: 'Join me here — press Start: https://t.me/{{bot_username}}?start=ref_{{chat_id}}' },
                },
              ],
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 3,
              message: '🎯 Milestone: **3 invites — Connector!** The 10-invite star tier is next.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 10,
              message: '🌟 **10 invites — Community star!** The team will feature you. Core member status at 25.',
            },
          },
          {
            type: 'milestone',
            milestone: {
              attribute: 'invites',
              value: 25,
              message: '👑 **25 invites — CORE MEMBER.** You are the engine of this community. The team owes you big.',
            },
          },
        ],
      },
      {
        id: 'news',
        title: 'Announcements',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text:
              '📣 The team posts announcements right here in this chat. Missed one? Ask here — the AI catches you up on what was posted.',
            buttons: [{ label: 'Share this bot', action: { kind: 'flow', behaviorId: 'share' } }],
          },
        ],
      },
      {
        id: 'share',
        title: 'Share this bot',
        when: { type: 'button' },
        steps: [
          {
            type: 'message',
            text: 'Know someone who should be here? Pass it on — your link is tracked, shares get noticed. 🙌',
            buttons: [
                {
                  label: 'Copy invite link',
                  action: {
                    kind: 'copy',
                    text: 'Check out this bot: https://t.me/{{bot_username}}?start=ref_{{chat_id}}',
                  },
                },
              ],
          },
        ],
      },
      groupGreetBehavior(),
      nuraeAboutBehavior(links, refCode),
    ],
  };
}

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

const BUILDERS: Record<string, (links: GrowthLinks, refCode: string) => BuiltTemplate> = {
  'referral-ambassador': buildReferralAmbassador,
  giveaway: buildGiveaway,
  'daily-trivia': buildDailyTrivia,
  'support-faq': buildSupportFaq,
  'community-hub': buildCommunityHub,
};

export function isTemplateId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILDERS, id);
}

/** Build one template's full bot configuration with the owner's growth hooks. */
export function buildTemplateBot(templateId: string, links: GrowthLinks, refCode: string): BuiltTemplate | null {
  const builder = BUILDERS[templateId];
  if (!builder) return null;
  const built = builder(links, refCode);
  // Growth hook guarantee: every template ends with the About NURAE behavior
  // and the welcome message carries the owner's referral line. Enforced
  // here, not hoped for.
  const welcome = built.behaviors.find((b) => b.when.type === 'start');
  if (!welcome || !built.behaviors.some((b) => b.id === 'nurae_about')) {
    throw new Error(`Template "${templateId}" is missing its growth hooks — refusing to instantiate.`);
  }
  const welcomeMsg = welcome.steps.find((s) => s.type === 'message');
  if (welcomeMsg && welcomeMsg.type === 'message') {
    welcomeMsg.text = `${welcomeMsg.text}${attributionLine(links, refCode)}`.slice(0, 4000);
  }
  return built;
}
