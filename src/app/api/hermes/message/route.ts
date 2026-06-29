// ============================================================
// POST /api/hermes/message
//
// Ingestion endpoint for the Hermes AI agent (external VPS).
// Authenticates via Bearer API key (same infra as /api/v1/*),
// then finds-or-creates the contact and conversation, and
// inserts the message into the messages table.
//
// Direction semantics:
//   inbound  — customer sent a message that Hermes received
//   outbound — Hermes replied to the customer
// ============================================================

import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/auth/api-context'
import { toApiErrorResponse } from '@/lib/api/v1/respond'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

type MediaKind = 'audio' | 'image' | 'document'

interface HermesMessageBody {
  contact_phone: string
  contact_name?: string | null
  message?: string | null
  direction: 'inbound' | 'outbound'
  media_url?: string | null
  media_type?: MediaKind | null
}

const VALID_MEDIA_TYPES = new Set<string>(['audio', 'image', 'document'])

function resolveContentType(mediaType: MediaKind | null | undefined): string {
  if (mediaType && VALID_MEDIA_TYPES.has(mediaType)) return mediaType
  return 'text'
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request)
    const { supabase, accountId } = ctx

    let body: HermesMessageBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { contact_phone, contact_name, message, direction, media_url, media_type } = body

    if (!contact_phone || typeof contact_phone !== 'string') {
      return NextResponse.json({ error: 'contact_phone is required' }, { status: 400 })
    }
    if (direction !== 'inbound' && direction !== 'outbound') {
      return NextResponse.json(
        { error: 'direction must be "inbound" or "outbound"' },
        { status: 400 },
      )
    }
    if (!message && !media_url) {
      return NextResponse.json(
        { error: 'At least one of message or media_url is required' },
        { status: 400 },
      )
    }
    if (media_type !== null && media_type !== undefined && !VALID_MEDIA_TYPES.has(media_type)) {
      return NextResponse.json(
        { error: 'media_type must be "audio", "image", "document", or null' },
        { status: 400 },
      )
    }

    const phone = normalizePhone(contact_phone)
    if (!phone) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
    }

    // Resolve a user_id to stamp on auto-created rows (contacts,
    // conversations). The API key carries its creator's user_id; if that
    // user was later removed from the account we fall back to any profile
    // still linked to the account.
    let ownerUserId = ctx.createdBy
    if (!ownerUserId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .limit(1)
        .maybeSingle()
      ownerUserId = profile?.user_id ?? null
    }
    if (!ownerUserId) {
      return NextResponse.json(
        { error: 'Account has no linked users — cannot create contact or conversation.' },
        { status: 500 },
      )
    }

    // ── Contact ──────────────────────────────────────────────────────────
    let contact = await findExistingContact(supabase, accountId, phone)

    if (!contact) {
      const name = contact_name?.trim() || phone
      const { data: newContact, error: createErr } = await supabase
        .from('contacts')
        .insert({ account_id: accountId, user_id: ownerUserId, phone, name })
        .select()
        .single()

      if (createErr) {
        if (isUniqueViolation(createErr)) {
          // Lost a race with a concurrent insert — re-resolve.
          contact = await findExistingContact(supabase, accountId, phone)
        }
        if (!contact) {
          console.error('[hermes/message] contact create failed:', createErr)
          return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
        }
      } else {
        contact = newContact
      }
    } else if (contact_name?.trim() && contact_name.trim() !== contact.name) {
      // Keep name in sync when Hermes sends a fresher display name.
      await supabase
        .from('contacts')
        .update({ name: contact_name.trim(), updated_at: new Date().toISOString() })
        .eq('id', contact.id)
    }

    // ── Conversation ─────────────────────────────────────────────────────
    const { data: existingConv, error: convFindErr } = await supabase
      .from('conversations')
      .select('id, unread_count')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .maybeSingle()

    if (convFindErr) {
      console.error('[hermes/message] conversation lookup failed:', convFindErr)
      return NextResponse.json({ error: 'Failed to look up conversation' }, { status: 500 })
    }

    let conversation: { id: string; unread_count: number }

    if (existingConv) {
      conversation = existingConv
    } else {
      const { data: newConv, error: convCreateErr } = await supabase
        .from('conversations')
        .insert({ account_id: accountId, user_id: ownerUserId, contact_id: contact.id })
        .select('id, unread_count')
        .single()

      if (convCreateErr) {
        console.error('[hermes/message] conversation create failed:', convCreateErr)
        return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
      }
      conversation = newConv
    }

    // ── Message ───────────────────────────────────────────────────────────
    const contentType = resolveContentType(media_type)
    const senderType = direction === 'inbound' ? 'customer' : 'agent'
    const contentText = message?.trim() || null

    const { data: msgRecord, error: msgErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: senderType,
        content_type: contentType,
        content_text: contentText,
        media_url: media_url || null,
        status: direction === 'inbound' ? 'delivered' : 'sent',
      })
      .select('id')
      .single()

    if (msgErr) {
      console.error('[hermes/message] message insert failed:', msgErr)
      return NextResponse.json({ error: 'Failed to insert message' }, { status: 500 })
    }

    // Bump conversation summary. Inbound messages increment unread_count
    // so the inbox badge reflects the new message.
    const convUpdate: Record<string, unknown> = {
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (direction === 'inbound') {
      convUpdate.unread_count = (conversation.unread_count || 0) + 1
    }
    await supabase.from('conversations').update(convUpdate).eq('id', conversation.id)

    return NextResponse.json({ status: 'ok', message_id: msgRecord.id })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
