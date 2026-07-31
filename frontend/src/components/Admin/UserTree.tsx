import type { UserTreeNode } from '../../types';
import { SectionTitle, TagSticker } from '../manga';

interface UserTreeProps {
  data: UserTreeNode | null;
  totalUsers: number;
}

function TreeNode({ node, level = 0 }: { node: UserTreeNode; level?: number }) {
  const isRoot = level === 0;
  const accent = isRoot ? 'var(--purple)' : level === 1 ? 'var(--pink)' : 'var(--cream)';
  const fg = isRoot ? 'var(--cream)' : 'var(--ink)';
  const initial = node.username.charAt(0).toUpperCase();

  return (
    <div style={{ marginLeft: level > 0 ? 28 : 0, borderLeft: level > 0 ? '3px dashed var(--ink)' : 'none', paddingLeft: level > 0 ? 16 : 0 }}>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          background: accent,
          color: fg,
          border: '3px solid var(--ink)',
          borderRadius: 4,
          boxShadow: '4px 4px 0 var(--ink)',
          marginBottom: 10,
          transform: `rotate(${(level % 2 ? -1 : 1) * 0.5}deg)`,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--cream)',
            color: 'var(--ink)',
            border: '2.5px solid var(--ink)',
            borderRadius: '50%',
            fontFamily: 'var(--font-sfx)',
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 18, letterSpacing: 1 }}>{node.username}</span>
            {isRoot && <TagSticker color="orange" rot={4}>ROOT</TagSticker>}
            {node.isDeleted && (
              <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 12, padding: '2px 8px', background: 'var(--orange)', color: 'var(--ink)', border: '2px solid var(--ink)', borderRadius: 4 }}>
                DELETED
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, fontWeight: 600, marginTop: 2 }}>{node.tag}</div>
        </div>
        {node.children.length > 0 && (
          <span className="hand" style={{ fontSize: 16, color: fg, opacity: 0.9 }}>
            {node.children.length} invite{node.children.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <TreeNode key={child.id} node={child} level={level + 1} />
      ))}
    </div>
  );
}

export function UserTree({ data, totalUsers }: UserTreeProps) {
  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: 28 }}>
        <p className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.55)' }}>
          no users yet — wild
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 18, alignItems: 'baseline', gap: 12 }}>
        <SectionTitle size={26} underline="pink">
          USER TREE
        </SectionTitle>
        <span className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.6)' }}>
          {totalUsers} total · everyone descends from root
        </span>
      </div>
      <TreeNode node={data} />
    </div>
  );
}
