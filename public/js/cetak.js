function renderCetak(d) {
  const id = d.identitas;
  const jk = id.jenis_kelamin === "L" ? "Laki-laki" : id.jenis_kelamin === "P" ? "Perempuan" : "-";
  const cat = d.catatan || {};
  const ttd = d.ttd;
  const tempat = ttd.tempat || ttd.kota || "";
  const tanggalTeks = ttd.tanggal_teks || ttd.tanggal || "";
  const kopHtml = d.sekolah.kop
    ? `<div class="kop"><img src="${esc(d.sekolah.kop)}" alt="Kop raport" class="kop-img"></div>`
    : `<div class="kop">
    <h2>${esc(d.sekolah.nama || "SMP NEGERI 1 PUNGGUR")}</h2>
    ${d.sekolah.alamat ? `<p>${esc(d.sekolah.alamat)}</p>` : ""}
  </div>`;
  return `
  ${kopHtml}
  <div class="judul-raport"><h3>${esc(d.sekolah.judul || "LAPORAN HASIL BELAJAR PESERTA DIDIK")}</h3></div>
  <table class="identitas">
    <tr><td style="width:170px">Nama Peserta Didik</td><td style="width:10px">:</td><td><b>${esc(id.nama)}</b></td>
        <td style="width:150px">Kelas</td><td style="width:10px">:</td><td>${esc(id.kelas || "-")}</td></tr>
    <tr><td>NIS</td><td>:</td><td>${esc(id.nis)}</td>
        <td>Semester</td><td>:</td><td>${esc(id.semester)}</td></tr>
    <tr><td>Jenis Kelamin</td><td>:</td><td>${esc(jk)}</td>
        <td>Tahun Ajaran</td><td>:</td><td>${esc(id.tahun_ajaran)}</td></tr>
    ${id.agama ? `<tr><td>Agama</td><td>:</td><td>${esc(id.agama)}</td><td></td><td></td><td></td></tr>` : ""}
  </table>
  <table class="nilai-cetak">
    <thead><tr><th style="width:40px">No</th><th>Mata Pelajaran</th><th style="width:80px">Nilai</th><th style="width:200px">Predikat</th></tr></thead>
    <tbody>
      ${d.rows.map((r, i) => `<tr>
        <td class="angka">${i + 1}</td><td>${esc(r.mapel)}</td>
        <td class="angka">${r.nilai !== null ? esc(r.nilai) : "-"}</td>
        <td>${esc(r.predikat || "-")}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  <div class="catatan-box"><b>Catatan BK</b>${esc(cat.bk || "-")}</div>
  <div class="catatan-box"><b>Catatan Wali Kelas</b>${esc(cat.wali || "-")}</div>
  <div class="catatan-box"><b>Catatan Ekstrakurikuler</b>${esc(cat.ekskul || "-")}</div>
  <div class="catatan-box"><b>Catatan Guru</b>${esc(cat.guru || "-")}</div>
  <p><b>Ketidakhadiran:</b> Sakit: ${d.kehadiran.sakit} hari &nbsp; Izin: ${d.kehadiran.izin} hari &nbsp; Tanpa keterangan: ${d.kehadiran.alpa} hari</p>
  <div class="ttd">
    <div class="kolom"></div>
    <div class="kolom">${esc(tempat)}${tempat ? "," : ""} ${esc(tanggalTeks)}<br>Kepala Sekolah<br><br><br>
      <div class="nama">${esc(ttd.kepala_nama || "........................")}</div>
      ${ttd.kepala_nip ? `NIP. ${esc(ttd.kepala_nip)}` : ""}
    </div>
  </div>
  <div class="ttd">
    <div class="kolom">Wali Kelas<br><br><br>
      <div class="nama">${esc(ttd.wali_nama || "........................")}</div>
      ${ttd.wali_nip ? `NIP. ${esc(ttd.wali_nip)}` : ""}
    </div>
    <div class="kolom"></div>
  </div>`;
}
