import SwiftUI

struct ProcessingUsageView: View {
  @ObservedObject var repository: ProcessingUsageRepository
  var body: some View {
    if let usage = repository.usage {
      VStack(alignment: .leading, spacing: 4) {
        Text("media_allowance_remaining") + Text(" \(Int(usage.remainingAudioSeconds / 60)) ")
          + Text("media_minutes")
        Text("media_allowance_reserved") + Text(" \(Int(ceil(usage.reservedAudioSeconds / 60))) ")
          + Text("media_minutes")
        if let next = usage.nextReplenishmentAt {
          Text("media_replenishes") + Text(" ") + Text(next, style: .date) + Text(" ")
            + Text(next, style: .time)
        }
      }.font(.caption).padding().frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial).accessibilityElement(children: .combine)
    }
  }
}
