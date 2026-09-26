import SwiftUI

struct AudioStepTimeline: View {
  let steps: [AudioStepPresentation]
  var timings: ServerStageTimings?

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
          if let measurement = step.measurement, measurement.durationMs >= 0 {
            let duration = String(format: "%.1f s", Double(measurement.durationMs) / 1_000)
            Text(
              measurement.complete
                ? duration : String(format: String(localized: "timing_partial"), duration)
            )
            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        .accessibilityElement(children: .combine)
      }
      if let timings {
        Divider().padding(.vertical, 12)
        Text("server_timings").font(.headline)
        Text("timing_note").font(.caption).foregroundStyle(.secondary).padding(.bottom, 8)
        ForEach(Array(timings.stages.enumerated()), id: \.offset) { _, measurement in
          if measurement.durationMs >= 0 {
            timingRow(stageTitle(measurement.stage), measurement.durationMs, measurement.complete)
          }
        }
        if let total = timings.totalMs, total >= 0 {
          timingRow("server_total", total, timings.totalComplete)
        }
      }
    }
  }

  private func timingRow(_ title: String, _ milliseconds: Int64, _ complete: Bool) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(LocalizedStringKey(title))
      Spacer()
      let duration = String(format: "%.1f s", Double(milliseconds) / 1_000)
      Text(complete ? duration : String(format: String(localized: "timing_partial"), duration))
        .monospacedDigit()
    }.font(.subheadline).padding(.vertical, 4)
  }

  private func stageTitle(_ stage: String) -> String {
    let known = [
      "import-queue", "source-download", "source-validation", "source-upload",
      "upload-confirmation", "submission-window", "queue", "retry-wait", "resource-check",
      "input-download", "input-validation", "preparation", "model-load", "separation", "denoise",
      "trim", "encoding", "output-validation", "output-ready", "output-upload", "completion",
    ]
    return known.contains(stage)
      ? "timing_stage_" + stage.replacingOccurrences(of: "-", with: "_") : "timing_stage_other"
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
