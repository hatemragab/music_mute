import SwiftUI

struct ProcessingUsageView: View {
  @ObservedObject var repository: ProcessingUsageRepository
  var body: some View {
    if let usage = repository.usage {
      VStack(alignment: .leading, spacing: 4) {
        Text("media_allowance_remaining")
          + Text(" \(Int(usage.processing.remainingSeconds / 60)) ")
          + Text("media_minutes")
        Text("media_allowance_reserved")
          + Text(" \(Int(ceil(usage.processing.reservedSeconds / 60))) ")
          + Text("media_minutes")
        Text("media_allowance_resets") + Text(" ")
          + Text(usage.period.nextResetAt, style: .date)
          + Text(" ") + Text(usage.period.nextResetAt, style: .time)
      }.font(.caption).padding().frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial).accessibilityElement(children: .combine)
    }
  }
}
