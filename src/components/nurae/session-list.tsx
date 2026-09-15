'use client';

/**
 * NURAE — shared session sidebar list (chat + agent views).
 *
 * One component so both workflows behave identically: open, rename,
 * archive, delete (with an inline confirm beat). Rows are typography —
 * title + preview, no cards.
 */

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SessionDTO } from '@/lib/nurae-client/api';

export function SessionList({
  sessions,
  activeId,
  onOpen,
  onRename,
  onDelete,
  onArchive,
  emptyText = 'Nothing here yet.',
}: {
  sessions: SessionDTO[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  emptyText?: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (!sessions.length) {
    return (
      <div className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto pb-4" aria-label="Conversations">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={
            'group flex items-center gap-1 px-2 ' +
            (s.id === activeId ? 'bg-muted/70' : 'hover:bg-muted/40')
          }
        >
          {editingId === s.id ? (
            <form
              className="flex-1 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                onRename(s.id, editingTitle.trim() || s.title);
                setEditingId(null);
              }}
            >
              <Input
                autoFocus
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={() => setEditingId(null)}
                className="h-7 text-xs"
                maxLength={60}
              />
            </form>
          ) : (
            <button type="button" onClick={() => onOpen(s.id)} className="min-w-0 flex-1 py-2 text-left">
              <span className="block truncate text-xs text-foreground">{s.title}</span>
              {s.preview && <span className="block truncate text-[11px] text-muted-foreground/70">{s.preview}</span>}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${s.title}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors group-hover:text-foreground hover:!text-foreground data-[state=open]:text-foreground md:text-muted-foreground/0 md:group-hover:text-muted-foreground"
            >
              ⋯
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              <DropdownMenuItem
                className="text-xs"
                onClick={() => {
                  setEditingId(s.id);
                  setEditingTitle(s.title);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onClick={() => onArchive(s.id)}>
                Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs text-destructive focus:text-destructive"
                onClick={() => {
                  if (confirmingId === s.id) {
                    onDelete(s.id);
                  } else {
                    setConfirmingId(s.id);
                    setTimeout(() => setConfirmingId((c) => (c === s.id ? null : c)), 3000);
                  }
                }}
              >
                {confirmingId === s.id ? 'Really delete?' : 'Delete'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
    </nav>
  );
}
