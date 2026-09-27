import { useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import type { UserTreeNode } from '../../types';
import { ChevronDownIcon, TreeIcon } from '../ui/icons';
import { spring } from '../ui/motion';

interface UserTreeProps {
  data: UserTreeNode | null;
  totalUsers: number;
}

/**
 * Who invited whom, drawn as a tree: every account hangs off the one that
 * invited it, back to root. Branches fold, so a large family stays readable.
 */
export function UserTree({ data, totalUsers }: UserTreeProps) {
  if (!data) {
    return (
      <div className="empty">
        <TreeIcon size={30} />
        <p className="empty__title">No one here yet</p>
        <p className="empty__text">Once root invites someone, the tree starts growing.</p>
      </div>
    );
  }

  return (
    <div className="tree">
      <p className="tree__summary">
        <strong>{totalUsers}</strong> {totalUsers === 1 ? 'person' : 'people'}, all invited in a line back to root.
      </p>
      <ul className="tree__root" role="tree" aria-label="Invite tree">
        <TreeNode node={data} level={0} />
      </ul>
    </div>
  );
}

function TreeNode({ node, level }: { node: UserTreeNode; level: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const isRoot = level === 0;
  const who = isRoot ? 'amber' : level % 2 === 1 ? 'them' : 'neutral';

  return (
    <li
      className="tree__item"
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-level={level + 1}
      aria-label={node.tag}
    >
      <div className="tree__node" data-deleted={node.isDeleted ? '' : undefined}>
        {hasChildren ? (
          <button
            type="button"
            className="tree__toggle"
            aria-label={open ? `Fold ${node.username}’s invites` : `Show ${node.username}’s invites`}
            onClick={() => setOpen((o) => !o)}
          >
            <m.span animate={{ rotate: open ? 0 : -90 }} transition={spring.snappy} style={{ display: 'grid' }}>
              <ChevronDownIcon size={16} />
            </m.span>
          </button>
        ) : (
          <span className="tree__toggle tree__toggle--leaf" aria-hidden="true" />
        )}
        <span
          className="avatar"
          data-who={who === 'amber' ? undefined : who}
          style={{ ['--av' as string]: '34px' }}
          aria-hidden="true"
        >
          {node.username.charAt(0).toUpperCase()}
        </span>
        <span className="tree__name">
          <span className="tree__username">{node.username}</span>
          <span className="tree__tag">{node.tag}</span>
        </span>
        {isRoot && <span className="chip chip--amber">Root</span>}
        {node.isDeleted && <span className="chip chip--exit">Deleted</span>}
        {hasChildren && (
          <span className="tree__count">
            invited {node.children.length}
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasChildren && open && (
          <m.ul
            role="group"
            className="tree__children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.soft}
          >
            {node.children.map((child) => (
              <TreeNode key={child.id} node={child} level={level + 1} />
            ))}
          </m.ul>
        )}
      </AnimatePresence>
    </li>
  );
}
