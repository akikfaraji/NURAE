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
import { buildTemplateBot, isTemplateId } from '@/lib/nurae/bots/templates';
import { resolveGrowthLinks } from '@/lib/nurae/bots/growth-links';
import { getOrCreateInvite } from '@/lib/nurae/referral';

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
