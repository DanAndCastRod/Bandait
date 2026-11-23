import React from 'react'
import { parseChatMarkdown, type MdInline } from '../../services/studio/chatMarkdown'

function renderInline(nodes: MdInline[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <React.Fragment key={i}>{node.text}</React.Fragment>
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>
      case 'code':
        return <code key={i}>{node.text}</code>
    }
  })
}

/** Respuesta del asistente con formato (chatMarkdown.ts). Solo elementos de React, nunca HTML. */
export const StudioChatMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const blocks = parseChatMarkdown(text)
  return (
    <div className="stu-md">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'paragraph':
            return (
              <p key={i}>
                {block.lines.map((line, n) => (
                  <React.Fragment key={n}>
                    {n > 0 && <br />}
                    {renderInline(line)}
                  </React.Fragment>
                ))}
              </p>
            )
          case 'heading':
            return (
              <p key={i} className="stu-md-heading">
                {renderInline(block.children)}
              </p>
            )
          case 'list': {
            const items = block.items.map((item, n) => <li key={n}>{renderInline(item)}</li>)
            return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
          }
          case 'code':
            return <pre key={i}>{block.text}</pre>
        }
      })}
    </div>
  )
}
