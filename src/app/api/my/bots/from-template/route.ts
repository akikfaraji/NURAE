/**
 * NURAE — /api/my/bots/from-template: one-click built-in bot creation.
 * POST { templateId } → creates the caller's bot from the built-in template.
 *
 * The owner's referral code rides the growth hooks: every template links
 * its audience to https://<site>/?ref=<ownerCode>, so a deployed bot grows
 * the platform while the owner earns premium days for qualified signups.
 * Identity comes from the session cookie — never from a body field.
 */

import { NextResponse } from 'next/server';
import { apiError, internalError } from '@/lib/nurae/api/base';
import { sessionUser } from '@/lib/nurae/auth/sessions';
import { createUserBot } from '@/lib/nurae/bots/user-bots';
import { buildTemplateBot, isTemplateId, type GrowthLinks } from '@/lib/nurae/bots/templates';
import { getOrCreateInvite } from '@/lib/nurae/referral';

/**
 * The public face of this instance: explicit env wins, then the OAuth
 * public URL, then the request's own origin (behind the same proxy the
 * user is on). Community/channel shortcuts are opt-in via env.
 */
function resolveGrowthLinks(req: Request): GrowthLinks {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const origin = `${proto}://${host}`;
  const trim = (v: string | undefined) => {
    const t = (v ?? '').trim();
    return /^https?:\/\//i.test(t) ? t : undefined;
  };
  return {
    siteUrl:
      trim(process.env.NURAE_SITE_URL) ??
      trim(process.env.NURAE_PUBLIC_URL) ??
      origin,
    communityUrl: trim(process.env.NURAE_COMMUNITY_URL),
    channelUrl: trim(process.env.NURAE_CHANNEL_URL),
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await sessionUser(req);
    if (!user) return apiError('Sign in first.', 401);
    if (!user.emailVerified) return apiError('Verify your email first.', 403);
    let body: { templateId?: unknown };
    try {
      body = (await req.json()) as { templateId?: unknown };
    } catch {
      return apiError('Invalid JSON body');
    }
    const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
    if (!isTemplateId(templateId)) {
      return apiError('Unknown built-in bot template.', 404);
    }
    const links = resolveGrowthLinks(req);
    const invite = await getOrCreateInvite(user.id);
    const built = buildTemplateBot(templateId, links, invite.code);
    if (!built) return apiError('Unknown built-in bot template.', 404);
    // The template's behaviors are the source of truth — the same validated
    // compile path the agent uses (createUserBot re-validates everything).
    const result = await createUserBot(user.id, {
      name: built.name,
      description: built.description,
      systemPrompt: built.systemPrompt,
      behaviors: built.behaviors,
    });
    if (result.error || !result.bot) {
      return NextResponse.json(
        { error: result.error ?? 'Could not create the bot', fields: result.fields },
        { status: 422 },
      );
    }
    return NextResponse.json({ bot: result.bot }, { status: 201 });
  } catch (err) {
    return internalError(err, 'my/bots.fromTemplate');
  }
}
