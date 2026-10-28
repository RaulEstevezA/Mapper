import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import './AppHeader.css'

/** Same navigation bar as the portfolio, so moving between the website and the tool feels seamless. */
export function AppHeader() {
  return (
    <header className="app-header app-header--wide">
      <nav className="app-header__nav">
        <a href="https://raulesteveza.github.io/" className="app-header__logo">
          Raúl Estévez
        </a>
        <div className="app-header__controls">
          <LanguageSwitcher />
        </div>
      </nav>
    </header>
  )
}
