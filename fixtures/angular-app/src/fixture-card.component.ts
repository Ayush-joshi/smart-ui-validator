import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

type FixtureState = 'default' | 'loading' | 'empty' | 'error' | 'disabled';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-state]': 'state()' },
  template: `
    <main class="page">
      <article class="card" data-validation-id="angular-card">
        <p class="eyebrow" data-validation-id="angular-eyebrow">Angular production adapter</p>
        <h1 data-validation-id="angular-title">Validated interface</h1>
        @if (state() === 'loading') {
          <p data-validation-id="angular-message" aria-live="polite">Loading component…</p>
        } @else if (state() === 'empty') {
          <p data-validation-id="angular-message">No design evidence is available.</p>
        } @else if (state() === 'error') {
          <p data-validation-id="angular-message" role="alert">Validation could not complete.</p>
        } @else {
          <p data-validation-id="angular-message">
            Native templates, signals, states, and responsive rules stay intact.
          </p>
        }
        <button
          data-validation-id="angular-action"
          type="button"
          [disabled]="isDisabled()"
          (click)="activate()"
        >
          {{ isDisabled() ? 'Unavailable' : 'Review report' }}
        </button>
      </article>
    </main>
  `,
})
export class FixtureCardComponent {
  readonly state = signal<FixtureState>(stateFromLocation());
  readonly activations = signal(0);
  readonly isDisabled = computed(() => this.state() === 'disabled' || this.state() === 'loading');

  activate(): void {
    this.activations.update((value) => value + 1);
  }
}

function stateFromLocation(): FixtureState {
  const value = new URLSearchParams(window.location.search).get('state');
  return ['loading', 'empty', 'error', 'disabled'].includes(value ?? '')
    ? (value as FixtureState)
    : 'default';
}
