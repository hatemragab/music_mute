import SwiftUI

enum LibraryFilter: String, CaseIterable, Identifiable {
  case all, mostPlayed, downloaded, notDownloaded, removed
  var id: String { rawValue }
  var title: LocalizedStringKey { LocalizedStringKey("library_filter_" + rawValue) }
}

enum LibrarySort: String, CaseIterable, Identifiable {
  case newest, title, mostPlayed
  var id: String { rawValue }
  var title: LocalizedStringKey { LocalizedStringKey("library_sort_" + rawValue) }
}

private struct LibraryPreferences: Codable {
  private struct StoredPlayCount: Decodable {
    let value: Int?
    init(from decoder: Decoder) throws {
      value = try? decoder.singleValueContainer().decode(Int.self)
    }
  }

  var favorites = Set<String>()
  var hidden = Set<String>()
  var playCounts: [String: Int] = [:]

  enum CodingKeys: CodingKey { case favorites, hidden, playCounts }

  init(favorites: Set<String>, hidden: Set<String>, playCounts: [String: Int]) {
    self.favorites = favorites
    self.hidden = hidden
    self.playCounts = playCounts
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    favorites = try values.decode(Set<String>.self, forKey: .favorites)
    hidden = try values.decode(Set<String>.self, forKey: .hidden)
    let counts =
      (try? values.decode([String: StoredPlayCount].self, forKey: .playCounts)) ?? [:]
    playCounts = counts.compactMapValues(\.value)
      .filter { !$0.key.isEmpty && $0.value > 0 }
  }
}

@MainActor final class LibraryPreferencesStore: ObservableObject {
  @Published private(set) var favorites = Set<String>()
  @Published private(set) var hidden = Set<String>()
  @Published private(set) var playCounts: [String: Int] = [:]
  private let defaults: UserDefaults
  private var ownerUID = ""

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  func bind(_ uid: String) {
    guard uid != ownerUID else { return }
    ownerUID = uid
    guard !uid.isEmpty,
      let data = defaults.data(forKey: storageKey),
      let value = try? JSONDecoder().decode(LibraryPreferences.self, from: data)
    else {
      favorites = []
      hidden = []
      playCounts = [:]
      return
    }
    favorites = value.favorites
    hidden = value.hidden
    playCounts = value.playCounts
  }

  func toggleFavorite(_ id: String) {
    guard !ownerUID.isEmpty else { return }
    var updated = favorites
    if !updated.insert(id).inserted { updated.remove(id) }
    favorites = updated
    save()
  }

  func toggleHidden(_ id: String) {
    guard !ownerUID.isEmpty else { return }
    var updated = hidden
    if !updated.insert(id).inserted { updated.remove(id) }
    hidden = updated
    save()
  }

  func recordPlayback(_ id: String, ownerUID: String) {
    guard !id.isEmpty, !ownerUID.isEmpty, ownerUID == self.ownerUID else { return }
    let previous = playCounts[id] ?? 0
    playCounts[id] = previous < Int.max ? previous + 1 : Int.max
    save()
  }

  private var storageKey: String { "musicmute.ios.library.\(ownerUID)" }

  private func save() {
    if let data = try? JSONEncoder().encode(
      LibraryPreferences(favorites: favorites, hidden: hidden, playCounts: playCounts))
    {
      defaults.set(data, forKey: storageKey)
    }
  }
}

enum LibrarySelection {
  static func jobs(
    _ jobs: [Job], search: String, filter: LibraryFilter, sort: LibrarySort,
    starredOnly: Bool, favorites: Set<String>, hidden: Set<String>, cachedIDs: Set<String>,
    playCounts: [String: Int]
  ) -> [Job] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return jobs.filter { job in
      guard job.status == "ready", job.canDownloadOutput,
        query.isEmpty || job.preferredName.localizedCaseInsensitiveContains(query),
        !starredOnly || favorites.contains(job.id)
      else { return false }
      if filter == .removed { return hidden.contains(job.id) }
      guard !hidden.contains(job.id) else { return false }
      switch filter {
      case .all: return true
      case .mostPlayed: return (playCounts[job.id] ?? 0) > 0
      case .downloaded: return cachedIDs.contains(job.id)
      case .notDownloaded: return !cachedIDs.contains(job.id)
      case .removed: return false
      }
    }.sorted { left, right in
      let ordering = filter == .mostPlayed ? LibrarySort.mostPlayed : sort
      if ordering == .mostPlayed {
        let leftCount = playCounts[left.id] ?? 0
        let rightCount = playCounts[right.id] ?? 0
        if leftCount != rightCount { return leftCount > rightCount }
      } else if ordering == .title {
        let comparison = left.preferredName.localizedCaseInsensitiveCompare(right.preferredName)
        if comparison != .orderedSame { return comparison == .orderedAscending }
      }
      if left.createdAt != right.createdAt { return left.createdAt > right.createdAt }
      return left.id < right.id
    }
  }
}

struct LibraryView: View {
  @ObservedObject var history: ProcessingHistoryModel
  @ObservedObject var model: ProcessingModel
  @ObservedObject var artifacts: JobArtifactRepository
  @ObservedObject var preferences: LibraryPreferencesStore
  var onOpenDetails: (Job) -> Void
  @State private var search = ""
  @State private var sort = LibrarySort.newest
  @State private var starredOnly = false
  @State private var filter = LibraryFilter.all
  @State private var cachedIDs = Set<String>()

  private var readyJobs: [Job] {
    model.libraryJobs.filter { $0.canDownloadOutput }
  }

  private var shownJobs: [Job] {
    LibrarySelection.jobs(
      readyJobs, search: search, filter: filter, sort: sort, starredOnly: starredOnly,
      favorites: preferences.favorites, hidden: preferences.hidden, cachedIDs: cachedIDs,
      playCounts: preferences.playCounts)
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text("library_title").font(.largeTitle.bold())
            Text("library_subtitle").foregroundStyle(.secondary)
          }
          Spacer()
          Menu {
            Picker("library_sort", selection: $sort) {
              ForEach(LibrarySort.allCases) { value in Text(value.title).tag(value) }
            }
          } label: {
            Image(systemName: "arrow.up.arrow.down")
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel(Text("library_sort"))
          .accessibilityValue(
            Text(filter == .mostPlayed ? LibrarySort.mostPlayed.title : sort.title)
          )
          .accessibilityIdentifier("librarySort")
          .disabled(filter == .mostPlayed)
        }
        TextField("library_search", text: $search)
          .textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never)
          .accessibilityIdentifier("librarySearch")
        Toggle(isOn: $starredOnly) {
          Label("library_show_starred", systemImage: "star.fill")
        }
        .toggleStyle(LibraryCheckboxStyle())
        .accessibilityIdentifier("libraryShowStarred")
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(LibraryFilter.allCases) { value in
              Button(value.title) { filter = value }
                .buttonStyle(.borderedProminent)
                .tint(filter == value ? VocalStyle.teal : Color.secondary.opacity(0.22))
                .accessibilityAddTraits(filter == value ? [.isSelected] : [])
                .accessibilityIdentifier("libraryFilter-\(value.rawValue)")
            }
          }
        }
        if history.loading && history.jobs.isEmpty { ProgressView() }
        if !history.loading && shownJobs.isEmpty {
          ContentUnavailableView(
            "library_empty", systemImage: "music.note.list", description: Text("library_empty_body")
          )
          .frame(maxWidth: .infinity).padding(.vertical, 36)
        }
        if let messageKey = history.messageKey {
          Text(LocalizedStringKey(messageKey)).foregroundStyle(.red)
        }
        if let messageKey = model.messageKey {
          Text(LocalizedStringKey(messageKey)).foregroundStyle(.secondary)
        }
        ForEach(shownJobs) { job in
          let progress = artifacts.progress[job.id]
          LibraryRow(
            job: job, favorite: preferences.favorites.contains(job.id),
            downloaded: cachedIDs.contains(job.id), hidden: preferences.hidden.contains(job.id),
            downloading: progress != nil,
            downloadProgress: progress.flatMap { value in
              value.totalBytes.flatMap { total in
                total > 0 ? Double(value.receivedBytes) / Double(total) : nil
              }
            },
            onFavorite: { preferences.toggleFavorite(job.id) },
            onPlay: { model.play(job, queue: shownJobs) },
            onDownload: {
              model.download(job) { _ in Task { await refreshCacheState() } }
            },
            onDetails: { onOpenDetails(job) },
            onHide: { preferences.toggleHidden(job.id) })
        }
        if history.nextCursor != nil {
          Button {
            Task { await history.loadMore() }
          } label: {
            HStack {
              if history.loadingMore { ProgressView() }
              Text("processing_more")
            }
          }
          .buttonStyle(.bordered).disabled(history.loading || history.loadingMore)
          .accessibilityIdentifier("libraryLoadMore")
        }
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }
    .navigationBarHidden(true)
    .task { await refreshCacheState() }
    .task(id: readyJobs.map(\.id).joined(separator: ":")) { await refreshCacheState() }
    .onChange(of: model.sessionReady) { _, ready in
      if !ready {
        starredOnly = false
        filter = .all
        search = ""
      }
    }
  }

  private func refreshCacheState() async {
    var next = Set<String>()
    for job in readyJobs {
      if await artifacts.isCached(jobId: job.id) { next.insert(job.id) }
    }
    cachedIDs = next
  }
}

private struct LibraryCheckboxStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button {
      configuration.isOn.toggle()
    } label: {
      HStack(spacing: 10) {
        Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
          .font(.title3).foregroundStyle(VocalStyle.teal)
        configuration.label
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("library_show_starred"))
    .accessibilityValue(Text(configuration.isOn ? "on" : "off"))
  }
}

private struct LibraryRow: View {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  let job: Job
  let favorite: Bool
  let downloaded: Bool
  let hidden: Bool
  let downloading: Bool
  let downloadProgress: Double?
  let onFavorite: () -> Void
  let onPlay: () -> Void
  let onDownload: () -> Void
  let onDetails: () -> Void
  let onHide: () -> Void

  var body: some View {
    VocalCard {
      HStack(spacing: 14) {
        JobArtwork(url: job.thumbnailURL, cornerRadius: 14) {
          Image(systemName: "waveform")
            .font(.title2).foregroundStyle(VocalStyle.teal)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VocalStyle.teal.opacity(0.13))
        }
        .frame(width: 48, height: 48)
        .shadow(color: .black.opacity(0.16), radius: 6, y: 3)
        VStack(alignment: .leading, spacing: 4) {
          Text(job.preferredName).font(.headline).lineLimit(2)
          HStack(spacing: 5) {
            Image(systemName: downloaded ? "arrow.down.circle.fill" : "icloud")
            Text(downloaded ? "library_downloaded" : "library_online")
          }.font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        Button(action: onFavorite) {
          Image(systemName: favorite ? "star.fill" : "star").frame(width: 44, height: 44)
        }.accessibilityLabel(Text(favorite ? "library_unfavorite" : "library_favorite"))
          .accessibilityIdentifier("libraryFavorite-\(job.id)")
      }
      LazyVGrid(
        columns: [
          GridItem(
            dynamicTypeSize.isAccessibilitySize ? .flexible() : .adaptive(minimum: 150),
            alignment: .leading)
        ], alignment: .leading, spacing: 10
      ) {
        Button(action: onPlay) { Label("play", systemImage: "play.fill") }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("libraryPlay-\(job.id)")
        if !downloaded {
          Button(action: onDownload) {
            Label(
              downloading ? "library_downloading" : "library_download",
              systemImage: "arrow.down.circle")
          }.buttonStyle(.bordered).disabled(downloading)
            .accessibilityIdentifier("libraryDownload-\(job.id)")
        }
        Button("processing_details", action: onDetails).buttonStyle(.bordered)
          .accessibilityIdentifier("libraryDetails-\(job.id)")
        Button(role: hidden ? nil : .destructive, action: onHide) {
          Image(systemName: hidden ? "arrow.uturn.backward" : "eye.slash")
            .frame(width: 44, height: 44)
        }.accessibilityLabel(Text(hidden ? "library_restore" : "library_hide"))
      }
      if downloading {
        if let downloadProgress {
          ProgressView(value: min(1, max(0, downloadProgress)))
        } else {
          ProgressView()
        }
      }
    }
  }
}
