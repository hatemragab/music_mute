import SwiftUI

struct ProcessingQueueStatus: View {
  let job: Job?
  let connection: RealtimeState
  var body: some View {
    if let job, job.status == "queued" {
      if connection != .live {
        Text("realtime_reconnecting").font(.subheadline).foregroundStyle(.secondary)
      } else if let queue = job.queue, queue.state == "waiting", let position = queue.position {
        Text(
          String.localizedStringWithFormat(String(localized: "realtime_queue_position"), position)
        )
        .font(.subheadline.weight(.semibold)).foregroundStyle(VocalStyle.teal)
      } else {
        Text(LocalizedStringKey(reason(job.queue?.reason))).font(.subheadline).foregroundStyle(
          .secondary)
      }
    }
  }
  private func reason(_ reason: String?) -> String {
    switch reason {
    case "account_capacity": return "realtime_account_wait"
    case "retry_backoff": return "realtime_retry_wait"
    case "processing_paused": return "realtime_processing_paused"
    case "worker_unavailable": return "realtime_worker_wait"
    default: return "realtime_queue_unavailable"
    }
  }
}

struct ProcessingConnectionStatus: View {
  let connection: RealtimeState
  var body: some View {
    Text(connection == .live ? "realtime_live" : "realtime_reconnecting")
      .font(.caption).foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
  }
}
