import SwiftUI

struct AudioStepTimeline: View {
  let steps: [AudioStepPresentation]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
        HStack(alignment: .top, spacing: 12) {
          VStack(spacing: 0) {
            Image(systemName: symbol(step.state))
              .foregroundStyle(color(step.state)).frame(width: 24, height: 24)
            if index < steps.count - 1 {
              Rectangle().fill(color(step.state).opacity(0.35)).frame(width: 2, height: 30)
            }
          }
          VStack(alignment: .leading, spacing: 3) {
            Text(LocalizedStringKey(step.titleKey)).font(.subheadline.weight(.semibold))
            if let date = step.occurredAt {
              Text(date, style: .time).font(.caption).foregroundStyle(.secondary)
            }
          }.padding(.top, 2)
          Spacer()
        }
        .accessibilityElement(children: .combine)
      }
    }
  }

  private func symbol(_ state: AudioStepState) -> String {
    switch state {
    case .complete: return "checkmark.circle.fill"
    case .active: return "waveform.circle.fill"
    case .failed: return "exclamationmark.circle.fill"
    case .cancelled: return "xmark.circle.fill"
    case .pending: return "circle"
    }
  }
  private func color(_ state: AudioStepState) -> Color {
    switch state {
    case .failed: return .red
    case .cancelled: return .secondary
    case .pending: return .secondary.opacity(0.55)
    default: return VocalStyle.teal
    }
  }
}
