import SwiftUI

struct DevicesView: View {
  @ObservedObject var model: AuthSessionModel
  @State private var pendingRemoval: RegisteredDevice?

  var body: some View {
    List {
      if model.devices.isEmpty, !model.isLoadingDevices {
        ContentUnavailableView(
          "auth_no_devices", systemImage: "iphone", description: Text("auth_no_devices_body"))
      }
      ForEach([true, false], id: \.self) { current in
        let group = model.devices.filter {
          ($0.installationId == model.currentInstallationID) == current
        }
        if !group.isEmpty {
          Section {
            ForEach(group) { device in
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Text(device.deviceModel ?? String(localized: "auth_ios_device")).font(.headline)
                  if device.installationId == model.currentInstallationID {
                    Text("auth_current_device").font(.caption.bold()).foregroundStyle(
                      VocalStyle.teal)
                  }
                }
                Text("\(device.platform) · \(device.osVersion)").foregroundStyle(.secondary)
                Text("\(device.appVersion) (\(device.buildNumber))").foregroundStyle(.secondary)
                Text(device.lastSeenAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                if !current {
                  Text(
                    LocalizedStringKey(
                      device.sessionStatus == "signed_out"
                        ? "device_history_signed_out" : "device_history_unknown")
                  )
                  .font(.caption).foregroundStyle(.secondary)
                  Button("device_history_remove") { pendingRemoval = device }
                    .disabled(model.isBusy || model.isLoadingDevices)
                    .accessibilityIdentifier("auth-remove-device-\(device.installationId)")
                }
              }
              .padding(.vertical, 4)
            }
          } header: {
            Text(LocalizedStringKey(current ? "auth_current_device" : "device_history_title"))
          } footer: {
            if !current { Text("device_history_description") }
          }
        }
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
    .alert(
      "device_history_remove_title",
      isPresented: Binding(
        get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }
      ), presenting: pendingRemoval
    ) { device in
      Button("device_history_remove", role: .destructive) {
        pendingRemoval = nil
        Task { await model.removeDeviceHistory(device) }
      }
      Button("cancel", role: .cancel) { pendingRemoval = nil }
    } message: { _ in
      Text("device_history_remove_body")
    }
    .refreshable { await model.loadDevices(reset: true) }
    .task { if model.devices.isEmpty { await model.loadDevices(reset: true) } }
  }
}
