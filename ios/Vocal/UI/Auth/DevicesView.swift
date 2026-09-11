import SwiftUI

struct DevicesView: View {
  @ObservedObject var model: AuthSessionModel

  var body: some View {
    List {
      if model.devices.isEmpty, !model.isLoadingDevices {
        ContentUnavailableView(
          "auth_no_devices", systemImage: "iphone", description: Text("auth_no_devices_body"))
      }
      ForEach(model.devices) { device in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(device.deviceModel ?? String(localized: "auth_ios_device")).font(.headline)
            if device.installationId == model.currentInstallationID {
              Text("auth_current_device").font(.caption.bold()).foregroundStyle(VocalStyle.teal)
            }
          }
          Text("\(device.platform) · \(device.osVersion)").foregroundStyle(.secondary)
          Text("\(device.appVersion) (\(device.buildNumber))").foregroundStyle(.secondary)
          Text(device.lastSeenAt, style: .relative).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
      }
      if model.devicesNextCursor != nil {
        Button("auth_load_more") { Task { await model.loadDevices() } }
          .disabled(model.isLoadingDevices)
      }
      if model.isLoadingDevices { ProgressView().frame(maxWidth: .infinity) }
      if let failure = model.lastFailure, failure != .cancelled {
        Label(LocalizedStringKey(failure.messageKey), systemImage: "exclamationmark.circle")
          .foregroundStyle(.red)
      }
    }
    .navigationTitle("auth_devices")
    .refreshable { await model.loadDevices(reset: true) }
    .task { if model.devices.isEmpty { await model.loadDevices(reset: true) } }
  }
}
