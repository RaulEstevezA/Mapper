import type { ReactNode } from 'react'
import './Pane.css'

/** One of the three workspace columns: a title bar with actions and a body that fills the height. */
export function Pane({
  title,
  actions,
  footer,
  children,
}: {
  title: string
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="pane" aria-label={title}>
      <header className="pane__header">
        <h2 className="pane__title">{title}</h2>
        {actions && <div className="pane__actions">{actions}</div>}
      </header>
      <div className="pane__body">{children}</div>
      {footer && <footer className="pane__footer">{footer}</footer>}
    </section>
  )
}
