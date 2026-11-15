import SwiftUI

struct AudioTaskCard: View {
  let task: AudioTaskPresentation
  var progress: Double?
  var onOpen: () -> Void
  var onCancel: () -> Void
  var onRetry: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var pulsing = false

  var body: some View {
    Button(action: onOpen) {
      VocalCard {
        HStack(alignment: .top, spacing: 14) {
          activeWaveform
          VStack(alignment: .leading, spacing: 5) {
            Text(task.title).font(.system(.headline, design: .rounded, weight: .bold))
              .foregroundStyle(.primary).lineLimit(2)
            Text(LocalizedStringKey(task.statusKey)).font(.subheadline.weight(.semibold))
              .foregroundStyle(task.isReady ? VocalStyle.teal : .secondary)
              .contentTransition(.opacity)
              .animation(.easeInOut(duration: reduceMotion ? 0 : 0.2), value: task.statusKey)
            HStack(spacing: 5) {
              Text("processing_total_time")
              AudioTaskElapsedTime(task: task)
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
          }
          Spacer(minLength: 4)
          Image(systemName: "chevron.forward").foregroundStyle(.tertiary)
        }
        if let progress {
          ProgressView(value: progress).tint(VocalStyle.teal)
            .accessibilityLabel(Text("processing_transfer_progress"))
        }
        footerLayout {
          referenceLayout {
            Text(task.jobID == nil ? "processing_reference" : "processing_job_id")
              .font(.caption).foregroundStyle(.secondary)
            Text(task.jobID ?? task.reference ?? "").font(.caption.monospaced())
              .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
              .truncationMode(.middle)
              .fixedSize(horizontal: false, vertical: true)
          }
          if !dynamicTypeSize.isAccessibilitySize { Spacer() }
          if task.canRetry {
            Button("retry", action: onRetry).buttonStyle(.bordered)
              .fixedSize(horizontal: false, vertical: true)
          } else if task.canCancel {
            Button("processing_cancel", role: .destructive, action: onCancel).buttonStyle(.bordered)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("audioTask-\(task.id)")
    .task(id: task.isActive && !reduceMotion) {
      guard task.isActive, !reduceMotion else {
        pulsing = false
        return
      }
      withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
        pulsing = true
      }
    }
    .onDisappear { pulsing = false }
  }

  private var footerLayout: AnyLayout {
    dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
      : AnyLayout(HStackLayout())
  }

  private var referenceLayout: AnyLayout {
    dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout())
  }

  private var activeWaveform: some View {
    HStack(alignment: .center, spacing: 3) {
      ForEach([0.45, 0.8, 0.55, 1, 0.65], id: \.self) { height in
        Capsule().fill(task.isReady ? VocalStyle.teal : VocalStyle.teal.opacity(0.75))
          .frame(width: 3, height: 24 * height)
          .scaleEffect(y: pulsing && task.isActive ? 0.55 : 1)
      }
    }
    .frame(width: 30, height: 30).accessibilityHidden(true)
  }
}

/// Only this leaf refreshes each second. Worker processing time remains the
/// server-measured sample; an offline client must not invent worker activity.
struct AudioTaskElapsedTime: View {
  let task: AudioTaskPresentation
  @State private var sampledAt = Date()

  var body: some View {
    Group {
      if task.isActive {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          elapsedText(audioTaskTotalSeconds(task, at: context.date, sampledAt: sampledAt))
        }
      } else {
        elapsedText(task.totalSeconds)
      }
    }
    .onChange(of: task.totalSeconds) { _, _ in sampledAt = Date() }
    .onChange(of: task.isActive) { _, _ in sampledAt = Date() }
  }

  private func elapsedText(_ seconds: Double?) -> Text {
    Text(
      seconds.map { (task.totalApproximate || task.isActive ? "≈ " : "") + audioTime($0) } ?? "—")
  }
}

func audioTaskTotalSeconds(
  _ task: AudioTaskPresentation, at date: Date, sampledAt: Date
) -> Double? {
  guard task.isActive else { return task.totalSeconds }
  if task.operationID != nil { return max(0, date.timeIntervalSince(task.createdAt)) }
  return task.totalSeconds.map { max(0, $0 + max(0, date.timeIntervalSince(sampledAt))) }
}
